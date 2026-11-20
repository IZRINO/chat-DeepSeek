import { create } from 'zustand'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_THINKING_EFFORT,
  isTokenLimit,
  normalizeApiBaseUrl,
  type ChatApiConfig,
} from './api/config.js'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 本机设置，存 localStorage：API Key、语言、主题、位置、朗读音色、深度思考与智能搜索开关、侧边栏收起状态 */
type Settings = ChatApiConfig & {
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  baseUrl: 'chat-demo:api-base-url',
  model: 'chat-demo:api-model',
  effort: 'chat-demo:thinking-effort',
  searchApiKey: 'chat-demo:search-api-key',
  contextTokens: 'chat-demo:context-tokens',
  maxOutputTokens: 'chat-demo:max-output-tokens',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialEffort = () => {
  const saved = read(KEYS.effort)
  return saved === 'low' || saved === 'max' ? saved : DEFAULT_THINKING_EFFORT
}

const readTokenLimit = (key: string, fallback: number) => {
  const value = Number(read(key))
  return isTokenLimit(value) ? value : fallback
}

const initialContextTokens = Math.max(2, readTokenLimit(KEYS.contextTokens, DEFAULT_CONTEXT_TOKENS))

export const useSettings = create<Settings>(() => ({
  apiKey: read(KEYS.apiKey),
  baseUrl: normalizeApiBaseUrl(read(KEYS.baseUrl) ?? '') ?? DEFAULT_API_BASE_URL,
  model: read(KEYS.model)?.trim() || DEFAULT_CHAT_MODEL,
  effort: initialEffort(),
  searchApiKey: read(KEYS.searchApiKey),
  contextTokens: initialContextTokens,
  maxOutputTokens: Math.min(
    readTokenLimit(KEYS.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS),
    DEFAULT_MAX_OUTPUT_TOKENS,
    initialContextTokens - 1
  ),
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiConfig = (config: ChatApiConfig) => {
  write(KEYS.apiKey, config.apiKey)
  write(KEYS.baseUrl, config.baseUrl)
  write(KEYS.model, config.model)
  write(KEYS.effort, config.effort)
  write(KEYS.searchApiKey, config.searchApiKey)
  write(KEYS.contextTokens, String(config.contextTokens))
  write(KEYS.maxOutputTokens, String(config.maxOutputTokens))
  useSettings.setState(config)
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
