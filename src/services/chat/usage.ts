import { usageInputTokens, usageTokens } from '../api/usage.js'
import { getVisibleMessages } from './branches.js'
import type { Session } from './types.js'

export const getSessionUsage = (session: Session, contextLimit: number) => {
  let totalTokens: number | undefined
  for (const reply of session.messages) {
    if (reply.role === 'assistant') {
      const tokens = reply.totalTokens ?? (reply.usage && usageTokens(reply.usage))
      if (tokens !== undefined) {
        totalTokens = (totalTokens ?? 0) + tokens
      }
    }
  }

  const latest = getVisibleMessages(session).findLast(
    (message) => message.role === 'assistant' && message.usage !== undefined
  )
  const usage = latest?.role === 'assistant' ? latest.usage : undefined
  const input = usage ? usageInputTokens(usage) : 0
  return {
    speed: latest?.role === 'assistant' ? latest.outputRate : undefined,
    totalTokens,
    cacheHit:
      usage?.cache_read_input_tokens !== undefined && input > 0
        ? usage.cache_read_input_tokens / input
        : undefined,
    context: usage ? usageTokens(usage) / contextLimit : undefined,
  }
}
