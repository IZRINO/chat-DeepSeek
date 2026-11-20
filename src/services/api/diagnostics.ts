export type MessageStage = 'search' | 'readLink' | 'chat'
export type MessageTransport = 'browser-fetch' | 'rust-http' | 'webview-fetch' | 'tauri-http'
export type MessageDiagnostic = {
  stage: MessageStage
  endpoint: string
  transport: MessageTransport
  /** Only a recognized network error, never a raw server response or request body. */
  reason?: string
  /** Structured service error for the local UI only. Never forwarded to a log. */
  serviceMessage?: string
  requestId?: string
}

export const transportLabels: Record<MessageTransport, string> = {
  'browser-fetch': 'Browser fetch',
  'rust-http': 'Rust HTTP',
  'webview-fetch': 'WebView fetch',
  'tauri-http': 'Tauri HTTP',
}

export const diagnosticEndpoint = (url: string) => {
  const { origin, pathname } = new URL(url)
  // A custom gateway may embed a credential in its path prefix.
  return (
    origin +
    (/^\/(?:(?:anthropic\/)?v1\/messages|v1\/tools\/(?:search|fetch))$/.test(pathname)
      ? pathname
      : '/…/v1/messages')
  )
}

export const networkReason = (error: unknown): string | undefined => {
  const reasons: string[] = []
  for (let depth = 0; error && depth < 4; depth++) {
    const code = typeof error === 'object' && 'code' in error ? error.code : ''
    const text = `${error instanceof Error ? error.message : typeof error === 'string' ? error : ''} ${typeof code === 'string' ? code : ''}`
    const matches = text.match(
      /\b(?:WinHTTP (?:open|connect|send|receive|read|configure|headers|callback) \d{1,10}|Rust HTTP (?:timeout|connect|read|request)(?: os error \d{1,5})?|Failed to fetch|fetch failed|Load failed|error sending request for url|NetworkError|ERR_[A-Z_]{1,48}|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|os error \d{1,5})\b/gi
    )
    if (matches) {
      reasons.push(...matches)
    }
    error = typeof error === 'object' && 'cause' in error ? error.cause : undefined
  }
  return [...new Set(reasons)].slice(0, 3).join(' · ') || undefined
}

export const reportMessageFailure = (
  diagnostic: MessageDiagnostic,
  kind: string,
  status?: number
) => {
  const { stage, endpoint, transport, reason } = diagnostic
  // Request diagnostics are deliberately visible in DevTools. Only allowlisted fields reach here.
  // eslint-disable-next-line no-console
  console.error(
    `[chat-api] ${stage} | POST ${endpoint} | ${transport} | ${kind} | HTTP ${status ?? 'none'}${reason ? ` | ${reason}` : ''}`
  )
  if (transport === 'browser-fetch' && process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
    const path = [
      stage,
      transport,
      kind,
      status ?? 'none',
      encodeURIComponent(reason ?? 'none'),
    ].join('/')
    // Only the local dev server has this route. Never send the user's endpoint, text or Key.
    void fetch(`/__chat_diagnostic/${path}`, {
      method: 'POST',
      mode: 'same-origin',
      credentials: 'omit',
      redirect: 'error',
    }).catch(() => {})
  }
}
