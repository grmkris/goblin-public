import { describe, expect, it } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { conversationId, entryId } from '../src/pi/context.ts'
import { firstThreadMessages } from '../src/thread-preview.ts'

function conversation(all: readonly EntryRecord[], id = '7') {
  const sizes: number[] = []
  return {
    id: conversationId(id),
    sizes,
    entries: async (query: { minEntryId?: number; maxEntryId?: number }, limit: number) => {
      sizes.push(limit)
      const own = all
        .filter((entry) => entry.id >= (query.minEntryId ?? 0) && entry.id <= (query.maxEntryId ?? Infinity))
        .toReversed()
      return { items: own.slice(0, limit) }
    },
  }
}
const entry = (id: number, text: string, session = '7'): EntryRecord => ({
  id: entryId(id),
  conversationId: conversationId(session),
  kind: 'pi.user',
  model: [{ role: 'user', content: text, timestamp: id }],
})

describe('bounded first thread messages', () => {
  it('returns the first five across a long sparse history, never the newest five or parent entries', async () => {
    const all = [entry(1, 'parent', '1'), ...Array.from({ length: 100 }, (_, i) => entry((i + 1) * 100, `own ${i}`))]
    const source = conversation(all)
    const messages = await firstThreadMessages(source, 1)
    expect(messages.map(({ text }) => text)).toEqual(['own 0', 'own 1', 'own 2', 'own 3', 'own 4'])
    expect(Math.max(...source.sizes)).toBe(40)
    expect(source.sizes.length).toBeLessThan(20)
  })
  it('clips large text, excludes memory markers and reports fewer messages before five exist', async () => {
    const marker: EntryRecord = {
      id: entryId(2),
      conversationId: conversationId('7'),
      kind: 'app.memory',
      model: [{ role: 'user', content: 'hidden', timestamp: 2 }],
    }
    expect(await firstThreadMessages(conversation([marker, entry(3, 'x'.repeat(10_000))]), 0)).toEqual([
      { role: 'user', text: 'x'.repeat(800), quiet: [] },
    ])
    expect(await firstThreadMessages(conversation([]), 0)).toEqual([])
  })
})
