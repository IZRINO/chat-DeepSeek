# 真DEEPSEEK 项目约定

## 产品路线

- 网页版正式入口是 [GitHub Pages](https://izrino.github.io/chat-DeepSeek/)。[Pages 工作流](.github/workflows/pages.yml) 从 `main` 构建并发布 `dist/`。
- 安装版面向 Windows 和 Android，采用 Tauri 2。界面资源随包分发，打开应用时从本地加载，生成回答时由设备直连用户选择的 API。构建见 [README](README.zh-CN.md#构建安装版)，选型依据见[应用封装](docs/app-packaging.md)。

## 共用前端与网络

- 两条路线复用 `src/` 中的 React 界面、会话逻辑和 API 协议。[请求入口](src/services/api/client.ts) 负责发请求，[SSE 读取](src/services/api/sse.ts) 负责流式数据。接入原生网络时优先在请求入口适配。
- 网页版遵循浏览器的 HTTPS 与跨域限制。安装版需要验证指定 HTTP 接口的直连、逐步显示回复、停止生成及附件上传。HTTP 直连时，聊天 Key 和消息以明文传输。
- 聊天走用户配置的服务。独立搜索使用单独的 DeepSeek 官方 Key，交给聊天模型的是可读的来源和摘要。用户凭据由使用者在运行时填写。

## 验证与发布

- 共用代码的现有检查为 `pnpm type`、`pnpm lint` 和 `pnpm test`。PowerShell 下先设 `$env:NODE_ENV = 'production'`，再运行 `pnpm exec rspack build -c rspack.config.ts` 生成 `dist/`。
- 渠道状态记录在[中文 README](README.zh-CN.md) 和[英文 README](README.md)。提交、推送和发布按用户本次指示执行。
