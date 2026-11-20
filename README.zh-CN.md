# 真DEEPSEEK

[English](README.md) | 简体中文

真DEEPSEEK 使用 React + Rspack 构建聊天界面，网页和应用两条路线共用这套前端。

| 使用方式 | 状态 | 界面与 API |
| --- | --- | --- |
| [GitHub Pages 网页版](https://izrino.github.io/chat-DeepSeek/) | 已上线 | 浏览器加载静态页面，直接请求支持 HTTPS 和跨域访问的 API。首次使用请在设置中填写聊天 Key。 |
| Windows、Android 安装版 | [v0.1.2 预览版](https://github.com/IZRINO/chat-DeepSeek/releases/tag/v0.1.2) | Tauri 2 随包提供界面，由设备的原生网络直接请求所配置的 HTTP 或 HTTPS API。 |

### GitHub Pages 的跨域限制

网页来源是 `https://izrino.github.io`。API 即使能用 HTTPS 访问，也必须允许这个来源执行 [CORS 预检](https://developer.mozilla.org/zh-CN/docs/Glossary/Preflight_request) 和实际请求。2026-11-20 实测 `https://lingtuapi.net/v1/messages` 对网页的 `OPTIONS` 预检返回 `403`，且缺少 `Access-Control-Allow-Origin`；浏览器因此没有发送聊天请求。服务商需要放行来源、方法及请求头（文本聊天使用 `content-type`、`x-api-key` 和 `anthropic-version`）。HTTPS 网页也不能直连公网的 `http://` API。

安装版不受浏览器跨域限制，但仍需正确的 Base URL、Anthropic Messages 兼容接口、模型 ID 和 Key。直接使用 HTTP 时，Key、消息及附件会明文传输，优先选 HTTPS。

如果使用自己管理的中转，在「设置 → API 设置」填入中转的 HTTPS Base URL（例如 `https://relay.example.com/v1`，不加 `/messages`）及对应的 Key 和模型 ID。中转需要接收 Anthropic Messages 请求并逐段转发 SSE，而不是等整段回复生成后再返回。给网页版使用时，CORS 由中转服务器放行。

## 运行

准备 Node.js 22.12+ 和 pnpm：

```sh
git clone https://github.com/IZRINO/chat-DeepSeek.git
cd chat-DeepSeek
pnpm install
pnpm dev
```

打开 http://localhost:8090 。

生成静态产物：

```sh
pnpm build
```

产物位于 `dist/`，可部署到静态服务器，也可直接打开 `dist/index.html`。直接打开时，浏览器和 API 服务需允许 `file://` 页面的存储与跨域请求。

### 构建安装版

按 [Tauri 工具链说明](https://v2.tauri.app/start/prerequisites/)准备 Rust、Windows C++ Build Tools 和 WebView2。构建 Android 还需要 JDK 17、Android SDK Platform 37.0、NDK，并设置 `JAVA_HOME`、`ANDROID_HOME`、`NDK_HOME`。

```powershell
pnpm tauri dev
pnpm tauri build
pnpm tauri android build --debug --apk --target aarch64
```

Windows 安装程序在 `src-tauri/target/release/bundle/nsis/`。Android 命令生成 ARM64 调试 APK，产物在 `src-tauri/gen/android/app/build/outputs/apk/`；x86_64 模拟器用 `--target x86_64`。正式分发前需要配置 [Android 发布签名](https://v2.tauri.app/distribute/sign/android/)。应用可以离线打开，生成回答仍需联网。设计和验收范围见[应用封装](docs/app-packaging.md)。

## 功能

- 多会话、自动标题、重命名与删除；编辑提问、重新生成和切换消息分支。
- 流式回答、深度思考、智能搜索、链接阅读与来源引用；支持停止和符合条件的继续生成。
- 附件上传、粘贴与拖拽，语音输入和回复朗读；移动端录音时输入框首行显示实时频谱。
- Markdown、代码高亮、KaTeX 公式和 Mermaid 图表。
- 简体中文与英文、浅色与深色主题、移动端布局、位置设置、历史导入导出。

## 数据

API Key 和设置保存在 localStorage，会话及附件原件保存在 IndexedDB。网页与安装版的本地数据彼此独立。发送对话、上传附件和使用语音功能时，相应内容会提交给配置的 API 服务。

设置中的历史导入导出使用 ZIP 格式。导入会在确认并校验成功后替换全部本地会话和附件；导出包含会话与本地可用的图片原件，不包含 API Key、设置或非图片附件原件。格式与保留范围见[历史导入导出](src/services/chat/history/README.md)。

设置 → 数据管理 → 删除所有对话，会在确认后清空全部本地会话、附件原件和未发送的草稿，停止正在生成的回复并回到新对话。API Key 和其他设置保留，已上传到 API 服务的文件不受影响。

## 开发

| 命令          | 用途                |
| ------------- | ------------------- |
| `pnpm dev`    | 启动开发服务器      |
| `pnpm build`  | 构建到 `dist/`      |
| `pnpm type`   | TypeScript 类型检查 |
| `pnpm lint`   | oxlint 检查         |
| `pnpm format` | oxfmt 格式化        |

[rspack.config.ts](rspack.config.ts) 默认连接 `https://api.deepseek.com`。`createConfig({ apiOrigin, devServer })` 支持自定义 API 地址和开发服务器代理。

在设置 → API 设置中填写 Anthropic Messages 兼容地址、模型 ID 和聊天 API Key。默认模型为 `deepseek-flash`，开启深度思考时默认强度为 `high`。配置独立的 DeepSeek 搜索 Key 后，DeepSeek 处理本轮联网搜索、图搜或链接阅读，然后由所选聊天模型根据返回的资料作答。

安装版沿用现有 Anthropic Messages 协议（也是 [dsh 支持的一种协议](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md#添加自定义模型-api)），请求使用自己的 `chat-DeepSeek` 客户端标识。只提供 OpenAI Chat Completions 等其他协议的服务不能直接使用；附件和语音也取决于服务商是否实现对应接口。

上下文长度和输出上限默认分别为 1M（1048576）和 384K（393216）token。发送消息时按配置预留输出空间，估算并裁剪超出的旧轮次。对话底部根据服务端用量显示输出速度、当前会话总消耗、最近一轮缓存命中率和上下文占用。

```text
src/
  app/                 应用布局、主题与全局样式
  components/          聊天、设置、Markdown 等界面组件
  i18n/                中英文文案
  services/
    api/               API 请求、SSE 与协议类型
    chat/              会话、消息分支、本地存储与历史导入导出
    markdown/          Markdown 解析、代码高亮与图表
    speech/            录音与朗读
  utils/               通用工具
```

## 许可证

[MIT](LICENSE)。构建会将许可证复制到 `dist/LICENSE`，分发时请一并保留；第三方依赖遵循各自的许可证。
