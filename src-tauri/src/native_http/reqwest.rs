use super::{Head, Result, Spec, RESPONSE_HEADERS};
use std::{error::Error, time::Duration};

pub const NAME: &str = "reqwest";
pub struct Body(reqwest::Response);
fn safe_error(error: reqwest::Error) -> String {
    let stage = if error.is_timeout() { "timeout" } else if error.is_connect() { "connect" }
        else if error.is_body() { "read" } else { "request" };
    let mut cause = error.source();
    while let Some(e) = cause {
        if let Some(code) = e.downcast_ref::<std::io::Error>().and_then(|io| io.raw_os_error()) {
            return format!("Rust HTTP {stage} os error {code}");
        }
        cause = e.source();
    }
    format!("Rust HTTP {stage}")
}
pub async fn open(spec: Spec) -> Result<(Head, Body)> {
    let config = spec.config;
    let client = reqwest::Client::builder().user_agent("chat-DeepSeek")
        .connect_timeout(Duration::from_secs(15)).read_timeout(Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(safe_error)?;
    let method = config.method.parse().map_err(|_| "Invalid API method")?;
    let mut request = client.request(method, config.url);
    for (k,v) in config.headers { request = request.header(k, v); }
    let response = request.body(spec.body).send().await.map_err(safe_error)?;
    let headers = RESPONSE_HEADERS.into_iter().filter_map(|k| {
        Some((k.to_owned(),response.headers().get(k)?.to_str().ok()?.to_owned()))
    }).collect();
    Ok((Head { status: response.status().as_u16(), headers }, Body(response)))
}
impl Body {
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>> {
        self.0.chunk().await.map(|v| v.map(|b| b.to_vec())).map_err(safe_error)
    }
}
