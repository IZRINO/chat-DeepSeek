export const DEEPSEEK_API_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_API_BASE_URL = __API_ORIGIN__
export const DEFAULT_CHAT_MODEL = 'deepseek-flash'
export const DEFAULT_CONTEXT_TOKENS = 1_048_576
export const DEFAULT_MAX_OUTPUT_TOKENS = 393_216
export const THINKING_EFFORTS = ['low', 'high', 'max'] as const
export type ThinkingEffort = (typeof THINKING_EFFORTS)[number]
export const DEFAULT_THINKING_EFFORT: ThinkingEffort = 'high'

export type ApiConnection = {
  baseUrl: string
  apiKey: string | null
}

export type ChatApiConfig = ApiConnection & {
  model: string
  effort: ThinkingEffort
  searchApiKey: string | null
  contextTokens: number
  maxOutputTokens: number
}

export const isTokenLimit = (value: number) => Number.isSafeInteger(value) && value > 0

/** 保留代理的路径前缀，拒绝带用户名、密码、查询参数或片段的地址。 */
export const normalizeApiBaseUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim())
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.includes('?') ||
      url.href.includes('#')
    ) {
      return null
    }
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export const messagesBaseUrl = (baseUrl: string) => {
  if (baseUrl.endsWith('/v1')) {
    return baseUrl
  }
  if (baseUrl.endsWith('/anthropic')) {
    return `${baseUrl}/v1`
  }
  return `${baseUrl}${baseUrl === DEFAULT_API_BASE_URL || baseUrl === DEEPSEEK_API_BASE_URL ? '/anthropic/v1' : '/v1'}`
}

// 构建时指定的地址仍可作为 DeepSeek 开发代理。
export const isDeepSeekApi = (baseUrl: string) =>
  baseUrl === DEFAULT_API_BASE_URL ||
  messagesBaseUrl(baseUrl) === `${DEEPSEEK_API_BASE_URL}/anthropic/v1`
