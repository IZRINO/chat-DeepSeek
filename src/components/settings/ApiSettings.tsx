import { useState } from 'react'
import { useTranslate, type TranslationMessage } from '../../i18n/index.js'
import { verifyApiKey } from '../../services/api/client.js'
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  isDeepSeekApi,
  isTokenLimit,
  messagesBaseUrl,
  normalizeApiBaseUrl,
  THINKING_EFFORTS,
  type ChatApiConfig,
  type ThinkingEffort,
} from '../../services/api/config.js'
import { classifyApiError } from '../../services/api/errors.js'
import { setApiConfig, useSettings } from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import styles from './Settings.module.css'

export const useApiSettingsForm = () => {
  const [draft, setDraft] = useState<ChatApiConfig>(() => {
    const { baseUrl, model, effort, apiKey, searchApiKey, contextTokens, maxOutputTokens } =
      useSettings.getState()
    return { baseUrl, model, effort, apiKey, searchApiKey, contextTokens, maxOutputTokens }
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<TranslationMessage | null>(null)

  const edit = (fields: Partial<ChatApiConfig>) => {
    setError(null)
    setDraft((previous) => ({ ...previous, ...fields }))
  }

  const editBaseUrl = (value: string) => {
    const saved = useSettings.getState()
    const next = normalizeApiBaseUrl(value)
    // 更换服务时清空沿用的旧 Key，用户可以填入新服务的 Key。
    const clearKey =
      next &&
      messagesBaseUrl(next) !== messagesBaseUrl(saved.baseUrl) &&
      draft.apiKey === saved.apiKey
    edit({ baseUrl: value, ...(clearKey ? { apiKey: null } : {}) })
  }

  const save = async () => {
    if (saving) {
      return
    }
    const baseUrl = normalizeApiBaseUrl(draft.baseUrl)
    if (!baseUrl) {
      setError({ key: 'apiBaseUrlInvalid' })
      return
    }
    if (
      !isTokenLimit(draft.contextTokens) ||
      !isTokenLimit(draft.maxOutputTokens) ||
      draft.maxOutputTokens >= draft.contextTokens ||
      draft.maxOutputTokens > DEFAULT_MAX_OUTPUT_TOKENS
    ) {
      setError({ key: 'apiTokenLimitsInvalid' })
      return
    }
    const next = {
      ...draft,
      baseUrl,
      model: draft.model.trim() || DEFAULT_CHAT_MODEL,
      apiKey: draft.apiKey?.trim() || null,
      searchApiKey: draft.searchApiKey?.trim() || null,
    }
    const current = useSettings.getState()
    setError(null)
    setSaving(true)
    try {
      // DeepSeek 支持免费校验。第三方只需实现 Messages API。
      if (
        next.apiKey &&
        isDeepSeekApi(baseUrl) &&
        (next.apiKey !== current.apiKey || baseUrl !== current.baseUrl)
      ) {
        await verifyApiKey(next)
      }
      setApiConfig(next)
      setDraft(next)
      showToast({ key: 'apiSettingsSaved' })
    } catch (cause) {
      const kind = classifyApiError(cause)
      setError(
        kind === 'unauthorized'
          ? { key: 'apiKeyInvalid' }
          : kind === 'network'
            ? { key: 'commonNetworkErrorToast' }
            : {
                key: 'apiKeyVerificationFailed',
                params: { message: cause instanceof Error ? cause.message : String(cause) },
              }
      )
    } finally {
      setSaving(false)
    }
  }

  return { draft, edit, editBaseUrl, save, saving, error }
}

export const ApiSettings = ({ form }: { form: ReturnType<typeof useApiSettingsForm> }) => {
  const t = useTranslate()
  const { draft, edit, editBaseUrl, save, saving, error } = form
  return (
    <form
      className={styles.apiForm}
      autoComplete="off"
      aria-busy={saving}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <label className={styles.apiField}>
        {t('apiBaseUrl')}
        <input
          className={styles.apiControl}
          value={draft.baseUrl}
          placeholder={DEFAULT_API_BASE_URL}
          aria-describedby="api-base-url-hint"
          aria-invalid={error?.key === 'apiBaseUrlInvalid'}
          inputMode="url"
          spellCheck={false}
          disabled={saving}
          onChange={(event) => editBaseUrl(event.target.value)}
        />
      </label>
      <div id="api-base-url-hint" className={styles.description}>
        {t('apiBaseUrlHint')}
      </div>
      <div className={styles.apiColumns}>
        <label className={styles.apiField}>
          {t('apiModel')}
          <input
            className={styles.apiControl}
            value={draft.model}
            placeholder={DEFAULT_CHAT_MODEL}
            spellCheck={false}
            disabled={saving}
            onChange={(event) => edit({ model: event.target.value })}
          />
        </label>
        <label className={styles.apiField}>
          {t('apiThinkingEffort')}
          <select
            className={styles.apiControl}
            value={draft.effort}
            disabled={saving}
            onChange={(event) => edit({ effort: event.target.value as ThinkingEffort })}
          >
            {THINKING_EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={styles.apiColumns}>
        <label className={styles.apiField}>
          {t('apiContextTokens')}
          <input
            className={styles.apiControl}
            type="number"
            inputMode="numeric"
            value={draft.contextTokens || ''}
            placeholder={String(DEFAULT_CONTEXT_TOKENS)}
            disabled={saving}
            onChange={(event) => edit({ contextTokens: Number(event.target.value) })}
          />
        </label>
        <label className={styles.apiField}>
          {t('apiMaxOutputTokens')}
          <input
            className={styles.apiControl}
            type="number"
            inputMode="numeric"
            value={draft.maxOutputTokens || ''}
            placeholder={String(DEFAULT_MAX_OUTPUT_TOKENS)}
            disabled={saving}
            onChange={(event) => edit({ maxOutputTokens: Number(event.target.value) })}
          />
        </label>
      </div>
      <label className={styles.apiField}>
        {t('apiChatKey')}
        <input
          className={styles.apiControl}
          type="password"
          autoComplete="new-password"
          value={draft.apiKey ?? ''}
          disabled={saving}
          onChange={(event) => edit({ apiKey: event.target.value })}
        />
      </label>
      <label className={styles.apiField}>
        {t('apiSearchKey')}
        <input
          className={styles.apiControl}
          type="password"
          autoComplete="new-password"
          value={draft.searchApiKey ?? ''}
          aria-describedby="api-search-key-hint"
          disabled={saving}
          onChange={(event) => edit({ searchApiKey: event.target.value })}
        />
      </label>
      <div id="api-search-key-hint" className={styles.description}>
        {t('apiSearchKeyHint')}
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          {t(error.key, error.params)}
        </div>
      ) : null}
      <Button className={styles.apiSave} type="submit" size="m" disabled={saving}>
        {t(saving ? 'apiKeyVerifying' : 'apiSettingsSave')}
      </Button>
    </form>
  )
}
