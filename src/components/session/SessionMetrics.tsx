import { useTranslate } from '../../i18n/index.js'
import type { Session } from '../../services/chat/types.js'
import { getSessionUsage } from '../../services/chat/usage.js'
import { useSettings } from '../../services/settings.js'
import styles from './SessionView.module.css'

const formatTokens = (count: number, locale: string) => {
  const format = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  if (count >= 1_000_000_000) {
    return `${format.format(count / 1_000_000_000)}B tok`
  }
  if (count >= 1_000_000) {
    return `${format.format(count / 1_000_000)}M tok`
  }
  if (count >= 1_000) {
    return `${format.format(count / 1_000)}K tok`
  }
  return `${format.format(count)} tok`
}

export const SessionMetrics = ({ session }: { session: Session }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const contextLimit = useSettings((state) => state.contextTokens)
  const { speed, totalTokens, cacheHit, context } = getSessionUsage(session, contextLimit)
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
  const cachePercent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })

  return (
    <div className={styles.metrics}>
      <span>
        {t('chatStatsSpeed', {
          value: speed === undefined ? '—' : `${number.format(speed)} tok/s`,
        })}
      </span>
      <span>
        {t('chatStatsTotal', {
          value: totalTokens === undefined ? '—' : formatTokens(totalTokens, locale),
        })}
      </span>
      <span>
        {t('chatStatsCache', {
          value: cacheHit === undefined ? '—' : cachePercent.format(cacheHit),
        })}
      </span>
      <span>
        {t('chatStatsContext', { value: context === undefined ? '—' : percent.format(context) })}
      </span>
    </div>
  )
}
