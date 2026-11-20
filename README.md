# 真DEEPSEEK

English | [简体中文](README.zh-CN.md)

真DEEPSEEK uses one React and Rspack chat frontend for its web and packaged app editions.

| Edition | Status | How it connects |
| --- | --- | --- |
| [GitHub Pages](https://izrino.github.io/chat-DeepSeek/) | Live | The browser loads the static site and calls an HTTPS API that allows cross-origin requests. Enter your chat API key in Settings. |
| Windows and Android apps | [v0.1.3 preview](https://github.com/IZRINO/chat-DeepSeek/releases/tag/v0.1.3) | The apps bundle the UI with Tauri 2 and connect directly to the configured HTTP or HTTPS API. |

### Cross-origin limits on GitHub Pages

The web app's origin is `https://izrino.github.io`. Even over HTTPS, the API must allow [CORS preflights](https://developer.mozilla.org/en-US/docs/Glossary/Preflight_request) and actual requests from that origin. On 2026-11-20, `https://lingtuapi.net/v1/messages` responded to the web app's `OPTIONS` preflight with `403` and no `Access-Control-Allow-Origin` header, so the browser did not send the chat request. Ask the provider to allow the origin, methods, and request headers (`content-type`, `x-api-key`, and `anthropic-version` for text chat). An HTTPS page also cannot call a public `http://` API directly.

The installed apps send chat and web lookup requests through native networking. Chat requires the correct base URL, Anthropic Messages support, model ID, and key. Use HTTPS to encrypt keys, messages, and attachments in transit.

For a relay you manage, enter its HTTPS base URL (for example, `https://relay.example.com/v1`, without `/messages`), API key, and model ID in Settings → API. The relay must accept Anthropic Messages requests and forward SSE chunks as they arrive. For web use, configure CORS on the relay.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/IZRINO/chat-DeepSeek.git
cd chat-DeepSeek
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. Deploy it to a static web server or open `dist/index.html` directly. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

### Build the native apps

Follow the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for Rust, Windows C++ Build Tools, and WebView2. For Android, install JDK 17, Android SDK Platform 37.0, and the NDK, and set `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME`.

```powershell
pnpm tauri dev
pnpm tauri build
pnpm tauri build --config src-tauri/tauri.chatgpt.conf.json
pnpm tauri android build --debug --apk --target aarch64
```

The Windows installers are under `src-tauri/target/release/bundle/nsis/`. Future releases ship two Windows x64 NSIS installers: the standard build `真DEEPSEEK_<version>_x64-setup.exe` (`chat-deepseek.exe`) and the disguised build `ChatGPT_<version>_x64-setup.exe` (`ChatGPT.exe`, built with `src-tauri/tauri.chatgpt.conf.json`). The Android command builds an ARM64 debug APK under `src-tauri/gen/android/app/build/outputs/apk/`; use `--target x86_64` for x86_64 emulators. Configure [Android release signing](https://v2.tauri.app/distribute/sign/android/) before distributing a release. The apps open offline, but generating replies still requires an API connection. See the [packaging notes (Chinese)](docs/app-packaging.md).

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key and settings are stored in localStorage. Conversations and original attachments are stored in IndexedDB. The web and installed apps have separate local storage. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Use Settings → API to configure an Anthropic Messages-compatible URL, model ID, and chat API key. The default model is `deepseek-flash`, and DeepThink defaults to `high` when enabled. With a separate official DeepSeek key, Smart Search uses the server-side tools on `https://api.deepseek.com/anthropic/v1/messages` and passes sources and summaries to the configured chat model. Explicit links can trigger lookup with Smart Search off. The search request can include attached images when Smart Search is on.

Expand **Error details** on a failed reply. The browser console and the `pnpm dev` terminal show `[chat-api]` diagnostics. The installed apps log native request failures as `[chat-api:rust]`. Logs omit keys, message bodies, and attachments.

The native apps use Anthropic Messages, [one of the protocols dsh supports](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md#add-a-custom-model-api), and identify native HTTP requests as `chat-DeepSeek`. Services that only expose another protocol, such as OpenAI Chat Completions, are not directly compatible. Files and speech also require the corresponding endpoints.

The context window and output limit default to 1M (1,048,576) and 384K (393,216) tokens. The client reserves space for the configured output and trims older rounds using a token estimate. The conversation footer uses reported usage to show output speed, total session tokens, cache hits, and context utilization.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
