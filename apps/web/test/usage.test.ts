import { describe, expect, it } from 'vitest'
import { budgetFraction, contextTokens } from '../src/lib/usage.ts'
import type { ChatMessage } from '../src/lib/chat-messages.ts'

const answer = (input: number, cacheRead = 0): ChatMessage => ({
  id: `a${input}`,
  role: 'assistant',
  text: 'ok',
  toolCalls: [],
  usage: { input, output: 50, cacheRead, cacheWrite: 0, totalTokens: input + cacheRead + 50 },
})

describe('usage for the composer and settings', () => {
  it('reads the context from the latest response that reported usage, cache included', () => {
    const messages: ChatMessage[] = [answer(900), { id: 'u', role: 'user', text: 'next' }, answer(1_200, 3_000)]
    expect(contextTokens(messages)).toBe(4_200)
    expect(contextTokens([{ id: 'u', role: 'user', text: 'hi' }])).toBeUndefined()
  })
  it('clamps the budget share and treats a zero limit as spent', () => {
    expect(budgetFraction({ used: 75_000, limit: 300_000, resetsAt: 0 })).toBe(0.25)
    expect(budgetFraction({ used: 400_000, limit: 300_000, resetsAt: 0 })).toBe(1)
    expect(budgetFraction({ used: 0, limit: 0, resetsAt: 0 })).toBe(1)
  })
})
