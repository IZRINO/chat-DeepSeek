use super::*;
use std::{io::{BufRead, BufReader, Read, Write}, net::{TcpListener, TcpStream}, thread, time::Duration};
use tokio::time::timeout;

fn server(handler: impl FnOnce(TcpStream) + Send + 'static) -> (String,thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (url,thread::spawn(move || {
        let (stream,_) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(8))).unwrap();
        handler(stream)
    }))
}
fn request(stream: &TcpStream) -> (String, Vec<u8>) {
    let mut reader = BufReader::new(stream);
    let mut headers = String::new();
    loop {
        let mut line = String::new();
        assert!(reader.read_line(&mut line).unwrap() > 0);
        if line == "\r\n" { break; }
        headers.push_str(&line);
    }
    let size = headers.lines().filter_map(|line| line.split_once(':'))
        .find(|(k,_)| k.eq_ignore_ascii_case("content-length"))
        .map(|(_,v)| v.trim().parse().unwrap()).unwrap_or(0);
    let mut data = vec![0; size];
    reader.read_exact(&mut data).unwrap();
    (headers, data)
}
fn spec(url: &str, method: &str, headers: Vec<(String,String)>, body: &[u8]) -> Spec {
    Config { url:url.parse().unwrap(), method:method.into(), headers }.validate(body.to_vec()).unwrap()
}
#[tokio::test]
async fn delivers_first_sse_chunk_before_the_server_finishes() {
    let (resume,wait) = std::sync::mpsc::channel();
    let (url,server) = server(move |mut s| {
        let (h,_) = request(&s);
        assert!(h.starts_with("POST /gateway/v1/messages "));
        s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: first\n\n").unwrap();
        wait.recv_timeout(Duration::from_secs(6)).unwrap();
        s.write_all(b"data: second\n\n").unwrap();
    });
    let t = Transfer::new(spec(&(url+"/gateway/v1/messages"),"POST",vec![],b"{}"));
    let head = t.send().await.unwrap();
    assert_eq!(head.status, 200);
    assert!(head.headers.contains(&("content-type".into(), "text/event-stream".into())));
    assert_eq!(timeout(Duration::from_secs(4),t.read()).await.unwrap().unwrap(), b"data: first\n\n");
    resume.send(()).unwrap();
    assert_eq!(t.read().await.unwrap(), b"data: second\n\n");
    assert!(t.read().await.unwrap().is_empty());
    server.join().unwrap();
}
#[tokio::test]
async fn sends_binary_multipart_and_does_not_follow_redirects() {
    let bytes = b"--probe\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.bin\"\r\n\r\n\0\xff\r\n--probe--\r\n";
    let (url,server) = server(move |mut s| {
        let (h,b) = request(&s);
        assert!(h.to_ascii_lowercase().contains("content-type: multipart/form-data; boundary=probe"));
        assert!(h.to_ascii_lowercase().contains("x-api-key: test-only"));
        assert_eq!(b, bytes);
        s.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/v1/files\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let t = Transfer::new(spec(&(url+"/v1/files"),"POST",vec![
        ("x-api-key".into(),"test-only".into()),("content-type".into(),"multipart/form-data; boundary=probe".into())],bytes));
    assert_eq!(t.send().await.unwrap().status, 307);
    assert!(t.read().await.unwrap().is_empty());
    server.join().unwrap();
}
#[tokio::test]
async fn cancellation_closes_the_socket_before_headers_and_during_a_body_read() {
    for headers_sent in [false, true] {
        let (started,wait) = oneshot::channel();
        let (closed,done) = oneshot::channel();
        let (url,server) = server(move |mut s| {
            request(&s);
            if headers_sent {
                s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 200\r\n\r\nfirst").unwrap();
            }
            started.send(()).unwrap();
            let mut b = [0;1];
            let result = s.read(&mut b);
            closed.send(matches!(result, Ok(0)) || result.is_err_and(|e| matches!(e.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted))).unwrap();
        });
        let t = Arc::new(Transfer::new(spec(&(url+"/v1/messages"),"POST",vec![],b"{}")));
        let other = t.clone();
        let send = tokio::spawn(async move { other.send().await });
        timeout(Duration::from_secs(8),wait).await.unwrap().unwrap();
        if headers_sent {
            assert_eq!(send.await.unwrap().unwrap().status,200);
            assert_eq!(timeout(Duration::from_secs(4),t.read()).await.unwrap().unwrap(),b"first");
            t.close();
        } else {
            t.close();
            assert!(timeout(Duration::from_secs(3),send).await.unwrap().unwrap().is_err());
        }
        assert!(timeout(Duration::from_secs(5),done).await.unwrap().unwrap());
        server.join().unwrap();
    }
}
#[test]
fn only_supports_known_paths_methods_and_headers() {
    for (method,url) in [
        ("POST","http://api.deepseek.com/v1/tools/search"),
        ("POST","https://other.example/v1/tools/fetch"),
        ("GET","https://other.example/models"), ("DELETE","https://x.example/v1/messages"),
        ("POST","https://x.example/v1/messages?key=secret"), ("POST","https://user:pass@x.example/v1/messages"),
    ] {
        let c = Config { url:url.parse().unwrap(),method:method.into(),headers:vec![] };
        assert!(c.validate(vec![]).is_err());
    }
    let c = Config { url:"https://api.deepseek.com/v1/tools/search".parse().unwrap(),method:"POST".into(),
        headers:vec![("host".into(),"other.example".into())] };
    assert!(c.validate(vec![]).is_err());
}

/// Explicit manual network check, never reads a user key or sends a billable query.
#[cfg(windows)]
#[test]
#[ignore = "compares local DNS and TCP with the WinHTTP probe, without credentials"]
fn live_official_tcp_route() {
    use std::net::ToSocketAddrs;
    let addresses: Vec<_> = ("api.deepseek.com", 443).to_socket_addrs().unwrap().collect();
    assert!(!addresses.is_empty(), "DNS returned no addresses");
    let mut connected = false;
    for address in addresses {
        match TcpStream::connect_timeout(&address, Duration::from_secs(4)) {
            Ok(_) => { connected = true; println!("TCP {address}: connected"); }
            Err(err) => println!("TCP {address}: {} ({:?})", err, err.raw_os_error()),
        }
    }
    assert!(connected, "no TCP connection; the server has not seen any HTTP headers or key");
}

#[tokio::test]
#[ignore = "requires connectivity to the public DeepSeek API"]
async fn live_official_api_without_credentials() {
    for (method,path) in [("GET","models"),("POST","anthropic/v1/messages")] {
        let t = Transfer::new(spec(&format!("https://api.deepseek.com/{path}"),method,
            vec![("content-type".into(),"application/json".into())],
            if method=="GET" { b"" } else { br#"{"model":"deepseek-flash","stream":true,"tools":[{"name":"deepseek_web_search","type":"deepseek_web_search"}],"messages":[{"role":"user","content":"test"}]}"# }));
        let head = timeout(Duration::from_secs(20),t.send()).await.unwrap().unwrap();
        println!("{} {method} /{path} -> HTTP {}", backend::NAME, head.status);
        assert_eq!(head.status,401);
        assert!(!t.read().await.unwrap().is_empty());
    }
}
