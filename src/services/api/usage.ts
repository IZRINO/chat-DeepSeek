import type { MessageUsage } from './types.js'

/** The start and delta events report snapshots. Some providers omit fields from later events. */
export const mergeUsage = (
  current: MessageUsage | undefined,
  update: Partial<MessageUsage> | undefined
): MessageUsage | undefined =>
  update ? { input_tokens: 0, output_tokens: 0, ...current, ...update } : current

export const usageInputTokens = (usage: MessageUsage) =>
  usage.input_tokens +
  (usage.cache_creation_input_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0)

export const usageTokens = (usage: MessageUsage) => usageInputTokens(usage) + usage.output_tokens
