import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@rspack/cli'
import { rspack, type Configuration } from '@rspack/core'

const dev = process.env.NODE_ENV !== 'production'
const targets = ['chrome >= 105', 'edge >= 105', 'safari >= 16', 'firefox >= 110']
const root = path.dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8')
) as { version: string }

const cssLoader = {
  loader: 'builtin:lightningcss-loader',
  options: { targets },
}

/** Local development only. Accept a fixed vocabulary, never log a request body or an arbitrary URL. */
const logChatDiagnostic = (req: IncomingMessage, res: ServerResponse) => {
  const { origin, host } = req.headers
  if (
    req.method !== 'POST' ||
    !host ||
    (origin !== `http://${host}` && origin !== `https://${host}`)
  ) {
    res.writeHead(403).end()
    return
  }
  const parts =
    /^\/(chat|search|readLink)\/(browser-fetch|webview-fetch|tauri-http)\/(network|http|protocol|stream|interrupted)\/(none|[1-5]\d\d)\/([a-zA-Z0-9_%.-]{1,220})$/.exec(
      req.url ?? ''
    )
  if (!parts) {
    res.writeHead(400).end()
    return
  }
  const [, stage, transport, kind, status, encoded] = parts
  let reason: string
  try {
    reason = decodeURIComponent(encoded)
  } catch {
    res.writeHead(400).end()
    return
  }
  if (!/^[a-zA-Z0-9_ ·]{1,120}$/.test(reason)) {
    res.writeHead(400).end()
    return
  }
  const target =
    stage === 'chat'
      ? 'configured chat API'
      : `https://api.deepseek.com/v1/tools/${stage === 'search' ? 'search' : 'fetch'}`
  process.stderr.write(
    `[chat-api] ${stage} | POST ${target} | ${transport} | ${kind} | HTTP ${status}${reason === 'none' ? '' : ` | ${reason}`}\n`
  )
  res.writeHead(204).end()
}

type ConfigOptions = {
  /** 公开 API 的地址，注入为 __API_ORIGIN__ */
  apiOrigin?: string
  /** 开发服务器配置，支持本地接口代理 */
  devServer?: Configuration['devServer']
}

/** 创建构建配置，支持自定义 API 地址和开发服务器选项 */
export const createConfig = ({
  apiOrigin = 'https://api.deepseek.com',
  devServer,
}: ConfigOptions = {}): Configuration => ({
  mode: dev ? 'development' : 'production',
  entry: './src/main.tsx',
  output: {
    path: path.resolve(root, 'dist'),
    // 运行时按当前脚本地址推导资源路径，file:// 下异步 chunk、字体都按相对位置加载
    publicPath: 'auto',
    filename: 'static/js/[name].[contenthash:8].js',
    chunkFilename: 'static/js/async/[name].[contenthash:8].js',
    cssFilename: 'static/css/[name].[contenthash:8].css',
    cssChunkFilename: 'static/css/async/[name].[contenthash:8].css',
    assetModuleFilename: 'static/media/[name].[contenthash:8][ext]',
    clean: true,
  },
  devtool: dev ? 'cheap-module-source-map' : false,
  // 开发模式预编译异步模块，保持首次加载代码高亮和公式时的页面状态
  lazyCompilation: false,
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    // 将 .js 导入路径解析到同名 .ts、.tsx 或 .js 文件
    extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
  },
  module: {
    // CSS Modules 使用默认导出：`import styles from './x.module.css'`
    parser: { 'css/module': { namedExports: false } },
    generator: { 'css/module': { localIdentName: '[local]-[hash:6]' } },
    rules: [
      { test: /\.module\.css$/, type: 'css/module', use: [cssLoader] },
      { test: /\.css$/, exclude: /\.module\.css$/, type: 'css', use: [cssLoader] },
      {
        test: /\.(j|t)sx?$/,
        exclude: /[\\/]node_modules[\\/]/,
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: { syntax: 'typescript', tsx: true },
            transform: { react: { runtime: 'automatic', development: dev } },
            externalHelpers: true,
          },
          env: { targets },
        },
        type: 'javascript/auto',
      },
      { test: /\.(woff2?|ttf)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    // 经典 defer 脚本支持 file:// 页面的资源加载
    new rspack.HtmlRspackPlugin({
      template: './src/index.html',
      scriptLoading: 'defer',
      meta: { 'application-version': version },
    }),
    new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify(apiOrigin) }),
    new rspack.CopyRspackPlugin({
      patterns: [{ from: path.resolve(root, 'LICENSE'), to: 'LICENSE', toType: 'file' }],
    }),
  ],
  performance: { hints: false },
  devServer: {
    port: 8090,
    setupMiddlewares: (middlewares) => [
      { name: 'chat-diagnostic', path: '/__chat_diagnostic', middleware: logChatDiagnostic },
      ...middlewares,
    ],
    ...devServer,
  },
})

// eslint-disable-next-line import/no-default-export
export default defineConfig(createConfig())
