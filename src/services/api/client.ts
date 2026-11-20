import { isTauri } from '@tauri-apps/api/core'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import {
  isDeepSeekApi,
  messagesBaseUrl,
  type ApiConnection,
} from './config.js'
import { readMessageEvent } from './parseEvent.js'
import {
  diagnosticEndpoint,
  networkReason,
  reportMessageFailure,
  type MessageDiagnostic,
  type MessageStage,
  type MessageTransport,
} from './diagnostics.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage
  diagnostic?: MessageDiagnostic
  serviceMessage?: string
  requestId?: string

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params), options)
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const responseRequestId = (response?: Response) => {
  const id =
    response?.headers.get('x-ds-request-id') ??
    response?.headers.get('request-id') ??
    response?.headers.get('x-request-id')
  return id && /^[\w.-]{1,120}$/.test(id) ? id : undefined
}

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let serviceMessage: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      serviceMessage = message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  const error = new ApiError(kind, message, response.status)
  error.serviceMessage = serviceMessage
  error.requestId = responseRequestId(response)
  return error
}

const transportFor = (): MessageTransport => isTauri() ? 'rust-http' : 'browser-fetch'

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    if (isTauri()) {
      const { nativeRequest } = await import('./native.js')
      response = await nativeRequest(url, init)
    } else {
      response = await fetch(url, init)
    }
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError(
      'network',
      error instanceof Error ? error.message : String(error),
      undefined,
      {
        cause: error,
      }
    )
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (connection: ApiConnection, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': connection.apiKey ?? '',
  ...(!isDeepSeekApi(connection.baseUrl) ? { 'anthropic-version': '2023-06-01' } : {}),
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 DeepSeek API Key（不产生费用） */
export const verifyApiKey = async (
  connection: ApiConnection,
  signal?: AbortSignal
): Promise<void> => {
  const root = connection.baseUrl.replace(/\/anthropic(?:\/v1)?$/, '')
  const response = await request(`${root}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${connection.apiKey ?? ''}` },
    redirect: 'error',
    signal,
  })
  await response.body?.cancel()
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  connection: ApiConnection,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${messagesBaseUrl(connection.baseUrl)}/files`, {
    method: 'POST',
    headers: anthropicHeaders(connection, true),
    redirect: 'error',
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (connection: ApiConnection, fileId: string): Promise<void> => {
  const response = await request(`${messagesBaseUrl(connection.baseUrl)}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(connection, true),
    redirect: 'error',
  })
  await response.body?.cancel()
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some(
        (block) =>
          (block.type === 'image' || block.type === 'document') && block.source.type === 'file'
      )
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  connection: ApiConnection,
  body: CreateMessageRequest,
  signal: AbortSignal,
  stage: MessageStage = 'chat'
): AsyncGenerator<MessageStreamEvent> {
  const url = `${messagesBaseUrl(connection.baseUrl)}/messages`
  let response: Response | undefined
  try {
    response = await request(url, {
      method: 'POST',
      headers: {
        ...anthropicHeaders(connection, hasFile(body)),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      redirect: 'error',
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    })
    yield* readMessageStream(response, signal)
  } catch (cause) {
    throw diagnoseFailure(
      stage,
      url,
      connection.apiKey,
      signal,
      cause,
      response,
      response ? 'interrupted' : 'protocol'
    )
  }
}

export const diagnoseFailure = (
  stage: MessageStage,
  url: string,
  key: string | null,
  signal: AbortSignal,
  cause: unknown,
  response?: Response,
  fallback: ApiErrorKind = 'protocol'
) => {
  signal.throwIfAborted()
  const error =
    cause instanceof ApiError ? cause : new ApiError(fallback, '', response?.status, { cause })
  const safeMessage = key
    ? error.serviceMessage?.replaceAll(key, '[redacted]')
    : error.serviceMessage
  const id = error.requestId ?? responseRequestId(response)
  error.diagnostic = {
    stage,
    endpoint: diagnosticEndpoint(url),
    transport: transportFor(),
    reason:
      error.kind === 'network' || error.kind === 'interrupted' ? networkReason(error) : undefined,
    serviceMessage: safeMessage?.replace(/\s+/g, ' ').trim().slice(0, 400),
    requestId: id && !(key && id.includes(key)) ? id : undefined,
  }
  reportMessageFailure(error.diagnostic, error.kind, error.status)
  return error
}

async function* readMessageStream(
  response: Response,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      const error = new ApiError('stream', payload.error.message, response.status)
      error.serviceMessage = error.message
      throw error
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data, response.status)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '', response.status)
}
