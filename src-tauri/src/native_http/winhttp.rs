use super::{Head, RESPONSE_HEADERS, Result, Spec};
use std::{
    ffi::c_void, mem::size_of, ptr::{NonNull, null, null_mut},
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use windows_sys::Win32::{Foundation::GetLastError, Networking::WinHttp::*};

pub const NAME: &str = "WinHTTP";
const BLOCK: usize = 32 * 1024;
type Raw = *mut c_void;

struct Handle(NonNull<c_void>);
// Asynchronous WinHTTP handles may move between threads. Only the pump calls
// methods or closes the handle; callbacks never call methods on it.
unsafe impl Send for Handle {}
impl Handle {
    fn new(raw: Raw, stage: &str) -> Result<Self> {
        NonNull::new(raw).map(Self).ok_or_else(|| last_error(stage))
    }
    fn raw(&self) -> Raw { self.0.as_ptr() }
}
impl Drop for Handle {
    fn drop(&mut self) { unsafe { WinHttpCloseHandle(self.raw()); } }
}
fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain([0]).collect() }
fn last_error(stage: &str) -> String {
    format!("WinHTTP {stage} {}", unsafe { GetLastError() })
}
fn check(ok: i32, stage: &str) -> Result<()> {
    if ok == 0 { Err(last_error(stage)) } else { Ok(()) }
}
fn option<T>(handle: &Handle, which: u32, value: &T) -> Result<()> {
    check(unsafe { WinHttpSetOption(handle.raw(), which, (value as *const T).cast(), size_of::<T>() as u32) }, "configure")
}

enum Event { Sent, Headers, Available(u32), Read(Vec<u8>), Error(u32) }
struct Context {
    events: mpsc::UnboundedSender<Event>,
    upload: Vec<u8>,
    // WinHTTP owns access to the allocation between ReadData and READ_COMPLETE.
    read_buffer: Mutex<Option<Vec<u8>>>,
    peer: Mutex<Option<std::net::IpAddr>>,
}
unsafe extern "system" fn on_status(_: Raw, id: usize, status: u32, info: Raw, length: u32) {
    if id == 0 { return; }
    let raw = id as *const Context;
    if status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING {
        // The last notification owns the strong reference installed by set_context.
        drop(unsafe { Arc::from_raw(raw) });
        return;
    }
    let context = unsafe { &*raw };
    let event = match status {
        WINHTTP_CALLBACK_STATUS_CONNECTING_TO_SERVER | WINHTTP_CALLBACK_STATUS_CONNECTED_TO_SERVER => {
            if !info.is_null() && (2..=256).contains(&length) {
                let address = unsafe { std::slice::from_raw_parts(info.cast::<u16>(), length as usize / 2) };
                let address = String::from_utf16_lossy(address);
                if let Ok(ip) = address.trim_end_matches('\0').parse() {
                    if let Ok(mut peer) = context.peer.lock() { *peer = Some(ip); }
                }
            }
            return;
        }
        WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE if !info.is_null() => Event::Available(unsafe { *info.cast::<u32>() }),
        WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE => Event::Sent,
        WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE => Event::Headers,
        WINHTTP_CALLBACK_STATUS_REQUEST_ERROR if !info.is_null() => {
            Event::Error(unsafe { (*info.cast::<WINHTTP_ASYNC_RESULT>()).dwError })
        }
        WINHTTP_CALLBACK_STATUS_READ_COMPLETE => {
            let Ok(mut slot) = context.read_buffer.lock() else { return };
            let Some(mut bytes) = slot.take() else { return };
            bytes.truncate(length as usize);
            Event::Read(bytes)
        }
        _ => return,
    };
    let _ = context.events.send(event);
}

pub struct Body {
    // Close children before parents, including on cancellation before headers.
    request: Handle,
    _connection: Handle,
    _session: Handle,
    context: Arc<Context>,
    events: mpsc::UnboundedReceiver<Event>,
}

impl Body {
    async fn event(&mut self, stage: &str) -> Result<Event> {
        match self.events.recv().await {
            Some(Event::Error(code)) => {
                let mut extra = 0u32;
                let mut size = size_of::<u32>() as u32;
                let known = unsafe { WinHttpQueryOption(self.request.raw(), WINHTTP_OPTION_EXTENDED_ERROR,
                    (&mut extra as *mut u32).cast(), &mut size) } != 0 && extra != 0;
                let peer = *self.context.peer.lock().unwrap();
                let mut reason = format!("WinHTTP {stage} {code}");
                if known { reason.push_str(&format!("; os error {extra}")); }
                if let Some(ip) = peer { reason.push_str(&format!("; peer={ip}")); }
                Err(reason)
            }
            Some(event) => Ok(event),
            None => Err("WinHTTP callback unavailable".into()),
        }
    }
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>> {
        // Read only bytes already available. Reading a full 32 KiB can wait for
        // a second SSE frame or EOF when the first frame is much smaller.
        check(unsafe { WinHttpQueryDataAvailable(self.request.raw(), null_mut()) }, "read")?;
        let size = match self.event("read").await? {
            Event::Available(0) => return Ok(None),
            Event::Available(n) => (n as usize).min(BLOCK),
            _ => return Err("Unexpected WinHTTP availability event".into()),
        };
        {
            let mut slot = self.context.read_buffer.lock().unwrap();
            let bytes = slot.insert(vec![0; size]);
            let ptr = bytes.as_mut_ptr();
            // A completion can run before ReadData returns. Release the lock first.
            drop(slot);
            check(unsafe { WinHttpReadData(self.request.raw(), ptr.cast(), size as u32, null_mut()) }, "read")?;
        }
        match self.event("read").await? {
            Event::Read(bytes) => Ok((!bytes.is_empty()).then_some(bytes)),
            _ => Err("Unexpected WinHTTP read event".into()),
        }
    }
}

fn response_head(request: &Handle) -> Result<Head> {
    let mut status = 0u32;
    let mut size = size_of::<u32>() as u32;
    check(unsafe { WinHttpQueryHeaders(request.raw(), WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        null(), (&mut status as *mut u32).cast(), &mut size, null_mut()) }, "headers")?;
    let mut headers = Vec::new();
    for name in RESPONSE_HEADERS {
        let key = wide(name);
        // All consumed headers are short. Never copy cookies, arbitrary response
        // headers, or request headers into the WebView.
        let mut value = [0u16; 1024];
        let mut size = (2 * value.len()) as u32;
        if unsafe { WinHttpQueryHeaders(request.raw(), WINHTTP_QUERY_CUSTOM, key.as_ptr(),
            value.as_mut_ptr().cast(), &mut size, null_mut()) } != 0 {
            headers.push((name.to_owned(), String::from_utf16_lossy(&value[..size as usize / 2])));
        }
    }
    Ok(Head { status: status as u16, headers })
}

pub async fn open(spec: Spec) -> Result<(Head, Body)> {
    let config = spec.config;
    let agent = wide("chat-DeepSeek");
    let mut raw = unsafe { WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, null(), null(), WINHTTP_FLAG_ASYNC) };
    // Some Windows configurations reject AUTOMATIC_PROXY at session creation (87).
    // Use the system's WinHTTP default in that case, never retry a sent request.
    if raw.is_null() && unsafe { GetLastError() } == 87 {
        raw = unsafe { WinHttpOpen(agent.as_ptr(), WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, null(), null(), WINHTTP_FLAG_ASYNC) };
    }
    let session = Handle::new(raw, "open")?;
    check(unsafe { WinHttpSetTimeouts(session.raw(), 15_000, 15_000, 120_000, 120_000) }, "configure")?;
    let url = &config.url;
    let host = wide(url.host_str().ok_or("Invalid API host")?);
    let port = url.port_or_known_default().ok_or("Invalid API port")?;
    let connection = Handle::new(unsafe { WinHttpConnect(session.raw(), host.as_ptr(), port, 0) }, "connect")?;
    let flags = WINHTTP_FLAG_ESCAPE_DISABLE | if url.scheme() == "https" { WINHTTP_FLAG_SECURE } else { 0 };
    let request = Handle::new(unsafe { WinHttpOpenRequest(connection.raw(), wide(&config.method).as_ptr(),
        wide(url.path()).as_ptr(), null(), null(), null(), flags) }, "open")?;
    option(&request, WINHTTP_OPTION_DISABLE_FEATURE, &(WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION))?;
    option(&request, WINHTTP_OPTION_DECOMPRESSION, &(WINHTTP_DECOMPRESSION_FLAG_GZIP | WINHTTP_DECOMPRESSION_FLAG_DEFLATE))?;
    let (tx, events) = mpsc::unbounded_channel();
    let context = Arc::new(Context { events: tx, upload: spec.body, read_buffer: Mutex::new(None), peer: Mutex::new(None) });
    let mask = WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE | WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE
        | WINHTTP_CALLBACK_STATUS_READ_COMPLETE | WINHTTP_CALLBACK_STATUS_REQUEST_ERROR | WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING
        | WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE | WINHTTP_CALLBACK_STATUS_CONNECTING_TO_SERVER | WINHTTP_CALLBACK_STATUS_CONNECTED_TO_SERVER;
    let previous = unsafe { WinHttpSetStatusCallback(request.raw(), Some(on_status), mask, 0) };
    if previous.is_some_and(|callback| callback as usize == usize::MAX) { return Err(last_error("callback")); }
    // Closing an async handle may deliver late callbacks. WinHTTP keeps one Arc
    // until HANDLE_CLOSING, so neither an in-flight upload nor read can dangle.
    let id = Arc::into_raw(context.clone()) as usize;
    if let Err(err) = option(&request, WINHTTP_OPTION_CONTEXT_VALUE, &id) {
        drop(unsafe { Arc::from_raw(id as *const Context) });
        return Err(err);
    }
    let mut body = Body { request, _connection: connection, _session: session, context, events };
    let headers = wide(&config.headers.into_iter().map(|(k,v)| format!("{k}: {v}\r\n")).collect::<String>());
    let len = body.context.upload.len() as u32;
    let data = if len == 0 { null() } else { body.context.upload.as_ptr().cast() };
    check(unsafe { WinHttpSendRequest(body.request.raw(), headers.as_ptr(), (headers.len()-1) as u32,
        data, len, len, id) }, "send")?;
    if !matches!(body.event("send").await?, Event::Sent) { return Err("Unexpected WinHTTP send event".into()); }
    check(unsafe { WinHttpReceiveResponse(body.request.raw(), null_mut()) }, "receive")?;
    if !matches!(body.event("receive").await?, Event::Headers) { return Err("Unexpected WinHTTP headers event".into()); }
    Ok((response_head(&body.request)?, body))
}
