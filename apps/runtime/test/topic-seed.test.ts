import type { Message } from '@earendil-works/pi-ai'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { conversationId, entryId } from '../src/pi/context.ts'
import { discussionSeed, latestOwnerExcerpt } from '../src/topics/seed.ts'

/** A Pi entry of `kind` with one model message. */
const entry = (id: number, kind: string, message: Message): EntryRecord => ({
  id: entryId(id),
  conversationId: conversationId('70'),
  kind,
  model: [message],
})
const user = (id: number, content: Extract<Message, { role: 'user' }>['content']) =>
  entry(id, 'pi.user', { role: 'user', content, timestamp: id })
const reply = (id: number, text: string) =>
  entry(id, 'pi.assistant', {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fixture',
    model: 'fixture',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: id,
  })

/** A conversation whose newest entries are `items`. */
const conversation = (items: readonly EntryRecord[]) => ({ entries: async () => ({ items: [...items] }) })

describe("a Topic's seed from the discussion (ADR 0032)", () => {
  it("keeps the latest user message as a frozen range through the chat's newest entry, cut to 1,200 characters", () => {
    const newestFirst = [reply(9, 'on it'), user(8, `make a topic for the garden ${'x'.repeat(2000)}`), user(3, 'old')]
    const excerpt = latestOwnerExcerpt('1', newestFirst)
    expect(excerpt).toMatchObject({ chat: '1', entryStart: 8, entryEnd: 9 })
    expect(excerpt?.excerpt).toHaveLength(1200)
    expect(excerpt?.excerpt.startsWith('make a topic for the garden')).toBe(true)
    expect(latestOwnerExcerpt('1', [reply(4, 'hello')])).toBeUndefined()
  })

  it("names another author's message, and seeds from the brief and the excerpt, or not at all", async () => {
    const authored = user(5, [
      { type: 'text', text: '[from Telegram]' },
      { type: 'text', text: 'plan the trip' },
    ])
    expect(latestOwnerExcerpt('1', [authored])?.excerpt).toBe('Telegram: plan the trip')
    expect(await discussionSeed(conversation([authored]), '1', 'Trips')).toEqual({
      brief: 'Trips',
      sources: [{ chat: '1', entryStart: 5, entryEnd: 5, excerpt: 'Telegram: plan the trip' }],
    })
    expect(await discussionSeed(conversation([]), '1', undefined)).toBeUndefined()
    expect(await discussionSeed(conversation([]), '1', 'Only a brief')).toEqual({ brief: 'Only a brief', sources: [] })
  })
})
