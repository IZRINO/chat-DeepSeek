import { ApiError } from './client.js'
import type { ChatApiConfig } from './config.js'
import type { MessageParam } from './types.js'

const encoder = new TextEncoder()
// Tokenizer varies by provider. Estimate text first, then use reported usage for the UI.
const textTokens = (text: string) => Math.ceil(encoder.encode(text).byteLength / 3)

const messageTokens = (message: MessageParam) =>
  4 +
  (typeof message.content === 'string'
    ? textTokens(message.content)
    : message.content.reduce((total, block) => {
        if (block.type === 'text') {
          return total + textTokens(block.text)
        }
        if (block.type === 'thinking') {
          return total + textTokens(block.thinking)
        }
        // The upstream service expands file IDs and encrypted web results.
        return total + 4
      }, 0))

const tokensIn = (messages: MessageParam[]) =>
  messages.reduce((total, message) => total + messageTokens(message), 0)

/** Keep the current question and optional prefix, then add complete old rounds that fit. */
export const fitConversation = (
  messages: MessageParam[],
  system: string,
  { contextTokens, maxOutputTokens }: Pick<ChatApiConfig, 'contextTokens' | 'maxOutputTokens'>
) => {
  const withReminder = (start: number) =>
    messages[start - 1]?.role === 'latest_reminder' ? start - 1 : start
  const lastUser = messages.findLastIndex(({ role }) => role === 'user')
  let start = lastUser < 0 ? 0 : withReminder(lastUser)
  let used = 4 + textTokens(system) + tokensIn(messages.slice(start))
  const max_tokens = Math.min(maxOutputTokens, contextTokens - used)
  if (max_tokens < 1) {
    throw new ApiError('protocol', { key: 'contextLimitExceeded' })
  }

  for (let index = start - 1; index >= 0; index -= 1) {
    if (messages[index].role !== 'user') {
      continue
    }
    const previous = withReminder(index)
    const added = tokensIn(messages.slice(previous, start))
    if (used + added + max_tokens > contextTokens) {
      break
    }
    used += added
    start = previous
    index = previous
  }

  const trimmed = messages.slice(start)
  if (trimmed[0]?.role !== 'latest_reminder') {
    const reminder = messages.slice(0, start).findLast(({ role }) => role === 'latest_reminder')
    if (reminder && used + messageTokens(reminder) + max_tokens <= contextTokens) {
      trimmed.unshift(reminder)
    }
  }
  return { messages: trimmed, max_tokens }
}
