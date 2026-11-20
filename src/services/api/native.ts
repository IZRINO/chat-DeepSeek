import { invoke } from '@tauri-apps/api/core'

type ResponseHead = { status: number; headers: [string, string][] }

/** The WebView encodes FormData but never opens an API connection. Reads are pull-based. */
export const nativeRequest = async (url: string, init: RequestInit): Promise<Response> => {
  const signal = init.signal
  signal?.throwIfAborted()
  const request = new Request(url, init)
  const body = await request.arrayBuffer()
  signal?.throwIfAborted()
  const rid = await invoke<number>('native_http_prepare', body, {
    headers: {
      'x-app-request': encodeURIComponent(JSON.stringify({
        url, method: request.method, headers: Array.from(request.headers),
      })),
    },
  })
  let closing: Promise<void> | undefined
  const close = () => {
    signal?.removeEventListener('abort', close)
    return (closing ??= invoke('native_http_close', { rid }).then(
      () => undefined,
      () => undefined
    ))
  }
  signal?.addEventListener('abort', close, { once: true })
  try {
    signal?.throwIfAborted()
    const { status, headers } = await invoke<ResponseHead>('native_http_send', { rid })
    signal?.throwIfAborted()
    if (status === 204 || status === 205 || status === 304) {
      await close()
      return new Response(null, { status, headers })
    }
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          signal?.throwIfAborted()
          const buffer = await invoke<ArrayBuffer>('native_http_read', { rid })
          signal?.throwIfAborted()
          const bytes = new Uint8Array(buffer)
          if (bytes.length) {
            controller.enqueue(bytes)
          } else {
            controller.close()
            await close()
          }
        } catch (error) {
          controller.error(signal?.aborted ? signal.reason : error)
          await close()
        }
      },
      cancel: close,
    })
    return new Response(stream, { status, headers })
  } catch (error) {
    await close()
    signal?.throwIfAborted()
    throw error
  }
}
