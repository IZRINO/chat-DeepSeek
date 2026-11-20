mod native_http;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            native_http::native_http_prepare, native_http::native_http_send,
            native_http::native_http_read, native_http::native_http_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
