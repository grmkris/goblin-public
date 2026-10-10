import type { UsageToday } from '@goblin/contracts'
import type { ChatMessage } from './chat-messages.ts'

/**
 * How many tokens the conversation's context held at the latest model response: its input, including what the
 * provider served from cache. Undefined before any response reported usage.
 */
export function contextTokens(messages: readonly ChatMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.usage !== undefined)
      return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
  }
  return undefined
}

/** The share of today's budget spent, 0 to 1. */
export const budgetFraction = (usage: UsageToday): number =>
  usage.limit <= 0 ? 1 : Math.min(1, Math.max(0, usage.used / usage.limit))
