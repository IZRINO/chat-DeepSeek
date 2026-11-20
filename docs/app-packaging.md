# Windows、Android 应用封装选型

安装版采用 **Tauri 2**。两端应用复用 React + Rspack 构建的 `dist/`，由 Tauri HTTP 插件提供原生请求、响应字节流和取消接口。构建命令见 [README](../README.zh-CN.md#构建安装版)。

GitHub Pages 网页版通过浏览器访问允许跨域的 HTTPS API。浏览器会拦截 HTTPS 页面发往普通 HTTP 地址的 `fetch`。安装版从包内加载界面，由设备直连用户选择的 API。离线时可以打开界面，生成回复仍需连接 API。[线上网页](https://izrino.github.io/chat-DeepSeek/) · [浏览器混合内容规则](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Mixed_content)

## 候选项目

| 项目 | 怎样复用现有界面、处理流式聊天 | 适合何时选 |
| --- | --- | --- |
| **Tauri 2** | 同一套壳加载本地 `dist/`。`@tauri-apps/plugin-http` 的 `fetch` 由 Rust 发请求，返回 `Response`。响应体按块读取，`AbortSignal` 和 `reader.cancel()` 均有取消路径，最接近现有请求接口。 | **首选。** 需维护 Rust 工程、配置允许访问的地址。插件上传前会先把请求体读入内存，较大附件要在手机上测。[静态前端](https://v2.tauri.app/start/frontend/) · [HTTP 插件与权限](https://v2.tauri.app/plugin/http-client/) · [已发布版实现](https://github.com/tauri-apps/plugins-workspace/blob/8c588be430d803019702f401e80b7cd5f1949aea/plugins/http/guest-js/index.ts#L150-L325) |
| **.NET MAUI HybridWebView** | 将 `dist/` 放入 `Resources/Raw/wwwroot/`。Windows 和 Android 共用 C# 网络层，以 `HttpClient` 的 `ResponseHeadersRead` 尽早取得响应，再逐块读取。需要自己把响应块送回 JS，并把停止动作接到请求和读流的 `CancellationToken`。 | 若团队熟悉 C#，或需要自行控制上传、读流和取消，可改选。要单独维护 JS/C# 消息桥及 .NET 工作负载。[支持平台](https://learn.microsoft.com/en-us/dotnet/maui/supported-platforms?view=net-maui-10.0) · [本地资源与消息桥](https://learn.microsoft.com/en-us/dotnet/maui/user-interface/controls/hybridwebview?view=net-maui-10.0) · [HttpClient](https://learn.microsoft.com/en-us/dotnet/api/system.net.http.httpclient.sendasync?view=net-10.0) |
| **Electron（Windows）+ Capacitor（Android）** | 两套壳共用 `dist/`。Windows 主进程可用 `net.request` 接收 `data` 分块并 `abort()`。Android 官方 `CapacitorHttp.request()` 只返回完整的 `Promise<HttpResponse>`，要由 Android 原生插件另行向 JS 发分块事件、接收取消。 | 已有 Electron 桌面代码或需要其生态时考虑。两端必须分别维护和测试传输实现，Electron 自身只支持桌面系统。[Electron 平台](https://www.electronjs.org/docs/latest/) · [响应块](https://www.electronjs.org/docs/latest/api/incoming-message) · [取消请求](https://www.electronjs.org/docs/latest/api/client-request) · [Capacitor HTTP](https://capacitorjs.com/docs/apis/http) · [Android 插件](https://capacitorjs.com/docs/plugins/android) |
| **PakePlus（PacBao）** | 项目支持把 React 的静态 `dist/` 封成 Windows、Android 应用，适合个人快速试装。对本项目的原生 HTTP、SSE、取消及附件支持仍需实测。 | 若只想先体验安装后的界面，可用本地打包。项目说明提到 GitHub 云打包会把资源放进公开仓库，也同时写有 MIT 与打包后限个人使用的说明。公开分发前要核对具体授权。[项目说明](https://github.com/Sjj1024/PakePlus#readme) |

## Tauri 安装版怎样验收

1. **核对安装版的网络边界。** DeepSeek 官方 Messages 沿用 WebView `fetch`。独立搜索和链接读取固定发往 `https://api.deepseek.com/v1/tools/search` 和 `/v1/tools/fetch`，使用原生 HTTP、Bearer 鉴权和 JSON；只有最终聊天请求使用 Messages SSE。各路径均支持取消，禁止携带 Key 跟随重定向。原生权限只给主窗口，两个新地址仅放行 DeepSeek 官方域名。[项目请求入口](../src/services/api/client.ts) · [原生权限](../src-tauri/capabilities/default.json) · [SSE 解析器](../src/services/api/sse.ts)
2. **两端都测真实的收包与停止。** 用测试凭据和可观察请求的兼容服务，在 Windows、Android 各跑一次。确认第一段文字在连接结束前出现，跨块的中文能正确显示。分别在等待首包、收到部分回答后让服务暂停发送时点停止，核对服务端连接确实断开，随后能正常发下一条。再测选图、非图片附件的上传和取消，确认独立检索 Key 只发到 `https://api.deepseek.com`。
3. **核实 HTTP 明文范围。** 在设备上用测试 Key 访问用户配置的 HTTP 接口，再切换地址验证。Android 默认限制明文流量，所用原生网络库是否执行系统策略须在真机核对。HTTP 会明文传输聊天 Key、内容和附件，设置页应向使用者说明这一点。[Android 网络安全配置](https://developer.android.com/privacy-and-security/security-config?hl=en)
4. **验证可分发的包。** Windows 侧需 MSVC 和 WebView2，可生成 MSI 或 NSIS 安装程序，公开分发需规划代码签名。Android 侧需 JDK、Android SDK/NDK 及对应的 Rust target，用签名 APK 试装，Google Play 发行走签名 AAB。发布者保管签名密钥。在两端安装后确认断网能打开本地界面，联网后能聊天。[工具链](https://v2.tauri.app/start/prerequisites/) · [Windows 安装程序](https://v2.tauri.app/distribute/windows-installer/) · [Windows 签名](https://v2.tauri.app/distribute/sign/windows/) · [Android 签名](https://v2.tauri.app/distribute/sign/android/) · [Google Play](https://v2.tauri.app/distribute/google-play/)

### 首轮验证（2026-11-20）

- 用不返回 CORS 许可的本地 HTTP 模拟接口及测试 Key 验证：网页被预检拦截；Windows 打包后的程序和 Android x86_64 模拟器上的 APK 均直接发出请求，分段显示跨块的中文。首包前和生成中停止均让服务端连接断开；停止后能再次发送。两端均成功上传测试文本附件，并在聊天请求中引用其文件 ID。
- [v0.1.2 预览版](https://github.com/IZRINO/chat-DeepSeek/releases/tag/v0.1.2)提供 Windows x64 NSIS 安装程序和两种 Android 调试 APK（ARM64、x86_64）。Windows 未做代码签名，APK 调试签名验证通过。ARM64 未在真机测试，第三方服务未用真实 Key 联调。

## Windows 双版本 Release 约定

后续发布 GitHub Release 时，Windows 均同时构建并附带两份 x64 NSIS 安装程序（连同 SHA-256 清单）：

| 版本 | 构建命令 | 安装包文件名 | 安装后应用名与主程序 | 用途说明 |
| --- | --- | --- | --- | --- |
| 正常版 | `pnpm tauri build` | `真DEEPSEEK_<version>_x64-setup.exe` | `真DEEPSEEK` / `chat-deepseek.exe` | 默认分发版本。 |
| ChatGPT 伪装版 | `pnpm tauri build --config src-tauri/tauri.chatgpt.conf.json` | `ChatGPT_<version>_x64-setup.exe` | `ChatGPT` / `ChatGPT.exe` | 仅通过 [tauri.chatgpt.conf.json](../src-tauri/tauri.chatgpt.conf.json) 覆写 `productName` 和 `mainBinaryName`，适配按进程名放行网络的受控终端环境；代码、功能与本地数据标识（`identifier`）与正常版一致。 |
