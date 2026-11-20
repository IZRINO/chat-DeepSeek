#[cfg(not(windows))]
#[path = "reqwest.rs"]
mod backend;
#[cfg(windows)]
#[path = "winhttp.rs"]
mod backend;
#[cfg(test)]
mod tests;

use std::sync::{Arc, Mutex};
use http::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use tauri::{Manager, Resource, ResourceId, Webview, ipc::{InvokeBody, Request, Response}};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use url::Url;

type Result<T> = std::result::Result<T, String>;
const RESPONSE_HEADERS: [&str; 4] = ["content-type", "x-request-id", "request-id", "x-ds-request-id"];
const MAX_BODY: usize = 65 * 1024 * 1024; // 64 MiB file plus multipart framing

#[derive(Deserialize)]
struct Config {
    url: Url,
    method: String,
    headers: Vec<(String, String)>,
}
struct Spec {
    config: Config,
    body: Vec<u8>,
    operation: &'static str,
}

impl Config {
    fn validate(self, body: Vec<u8>) -> Result<Spec> {
        let u = &self.url;
        if !matches!(u.scheme(), "https" | "http") || u.host().is_none()
            || !u.username().is_empty() || u.password().is_some() || u.query().is_some()
            || u.fragment().is_some() || body.len() > MAX_BODY
        {
            return Err("Invalid API request".into());
        }
        let path = u.path();
        let official = u.origin().ascii_serialization() == "https://api.deepseek.com";
        let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
        let operation = match (self.method.as_str(), parts.as_slice()) {
            ("GET", ["models"] | ["v1", "models"]) if official => "models",
            ("POST", [.., "v1", "messages"]) => "messages",
            ("POST", [.., "v1", "files"]) => "upload",
            ("DELETE", [.., "v1", "files", id]) if !id.is_empty() => "delete-file",
            ("POST", [.., "v1", "tools", "asr"]) => "asr",
            ("POST", [.., "v1", "tools", "tts"]) => "tts",
            _ => return Err("Unsupported API operation".into()),
        };
        if self.headers.len() > 16 || self.headers.iter().any(|(key,value)| {
            !matches!(key.to_ascii_lowercase().as_str(), "accept" | "content-type" | "authorization"
                | "x-api-key" | "anthropic-version" | "anthropic-beta")
                || HeaderName::from_bytes(key.as_bytes()).is_err()
                || HeaderValue::from_str(value).is_err() || !value.is_ascii()
        }) {
            return Err("Unsupported API headers".into());
        }
        Ok(Spec { config: self, body, operation })
    }
}

#[derive(Serialize, Debug)]
pub(crate) struct Head {
    status: u16,
    headers: Vec<(String, String)>,
}
struct Transfer {
    spec: Mutex<Option<Spec>>,
    body: tokio::sync::Mutex<Option<mpsc::Receiver<Result<Vec<u8>>>>>,
    cancel: CancellationToken,
}
impl Transfer {
    fn new(spec: Spec) -> Self {
        Self { spec: Mutex::new(Some(spec)), body: Default::default(), cancel: CancellationToken::new() }
    }
    async fn send(&self) -> Result<Head> {
        let spec = self.spec.lock().unwrap().take().ok_or("Request already sent")?;
        let op = spec.operation;
        let (head_tx, head_rx) = oneshot::channel();
        let (tx, rx) = mpsc::channel(2);
        *self.body.lock().await = Some(rx);
        let cancel = self.cancel.clone();
        tauri::async_runtime::spawn(async move {
            let pump = async {
                let (head, mut response) = match backend::open(spec).await {
                    Ok(result) => result,
                    Err(error) => {
                        eprintln!("[chat-api:rust] {op} | {} | {error}", backend::NAME);
                        let _ = head_tx.send(Err(error));
                        return;
                    }
                };
                if head.status >= 300 {
                    eprintln!("[chat-api:rust] {op} | {} | HTTP {}", backend::NAME, head.status);
                }
                if head_tx.send(Ok(head)).is_err() { return; }
                loop {
                    match response.chunk().await {
                        Ok(Some(bytes)) => if tx.send(Ok(bytes)).await.is_err() { break; },
                        Ok(None) => break,
                        Err(error) => {
                            eprintln!("[chat-api:rust] {op} | {} | {error}", backend::NAME);
                            let _ = tx.send(Err(error)).await;
                            break;
                        }
                    }
                }
            };
            tokio::select! { biased; _ = cancel.cancelled() => (), _ = pump => () }
        });
        head_rx.await.map_err(|_| "Request cancelled".to_string())?
    }
    async fn read(&self) -> Result<Vec<u8>> {
        let mut body = self.body.lock().await;
        let reader = body.as_mut().ok_or("Response not started")?;
        reader.recv().await.unwrap_or_else(|| Ok(Vec::new()))
    }
}
impl Drop for Transfer {
    fn drop(&mut self) { self.cancel.cancel(); }
}
impl Resource for Transfer {
    fn close(self: Arc<Self>) { self.cancel.cancel(); }
}

#[tauri::command]
pub fn native_http_prepare(webview: Webview, request: Request<'_>) -> Result<ResourceId> {
    let metadata = request.headers().get("x-app-request").filter(|h| h.len() <= 32768)
        .ok_or("Missing API metadata")?;
    let json = percent_encoding::percent_decode(metadata.as_bytes()).collect::<Vec<_>>();
    let config: Config = serde_json::from_slice(&json).map_err(|_| "Invalid API metadata")?;
    let body = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= MAX_BODY => bytes.clone(),
        // Android's fallback IPC serializes binary payloads as an array of octets.
        InvokeBody::Json(v) if v.as_array().is_some_and(|a| a.len() <= MAX_BODY) =>
            Vec::<u8>::deserialize(v).map_err(|_| "Invalid API body")?,
        _ => return Err("Invalid API body".into()),
    };
    Ok(webview.resources_table().add(Transfer::new(config.validate(body)?)))
}
fn transfer(webview: &Webview, rid: ResourceId) -> Result<Arc<Transfer>> {
    webview.resources_table().get(rid).map_err(|_| "Request closed".into())
}
#[tauri::command]
pub async fn native_http_send(webview: Webview, rid: ResourceId) -> Result<Head> {
    transfer(&webview,rid)?.send().await
}
#[tauri::command]
pub async fn native_http_read(webview: Webview, rid: ResourceId) -> Result<Response> {
    Ok(Response::new(transfer(&webview,rid)?.read().await?))
}
#[tauri::command]
pub fn native_http_close(webview: Webview, rid: ResourceId) {
    if let Ok(resource) = webview.resources_table().take::<Transfer>(rid) { resource.close(); }
}
