import type { EntryRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from 'vitest'
import { tailTokens } from '../src/memory/chat-memory.ts'
import type { TextCompletion } from '../src/memory/model.ts'
import { summarize } from '../src/memory/summarize.ts'
import { NODE_BYTES, byteLength } from '../src/memory/tree.ts'
import { conversationId, entryId } from '../src/pi/context.ts'

/** A memory model that answers from `replies` in turn, then with an empty line; it counts its calls. */
function replying(replies: string[]) {
  const model = {
    calls: 0,
    complete: () => {
      model.calls += 1
      return Promise.resolve(replies.shift() ?? '')
    },
  }
  return model satisfies TextCompletion
}

const long = (word: string) => `${word} `.repeat(200).trim()

describe('a memory line (unit)', () => {
  it('keeps the source, cut to size, when every try comes back empty', async () => {
    const model = replying([])
    const line = await summarize(model, [], { kind: 'compress', message: long('alpha') })
    expect(model.calls).toBe(3)
    expect(line.startsWith('alpha alpha')).toBe(true)
    expect(byteLength(line)).toBeLessThanOrEqual(NODE_BYTES)
    const merged = await summarize(replying([]), [], { kind: 'merge', lines: [long('first'), long('second')] })
    expect(merged).toMatch(/^first .* second/u)
    expect(byteLength(merged)).toBeLessThanOrEqual(NODE_BYTES)
  })

  it('treats an empty reply as a used try and keeps the next good one', async () => {
    const model = replying(['', 'user: asked for alpha.'])
    expect(await summarize(model, [], { kind: 'compress', message: long('alpha') })).toBe('user: asked for alpha.')
    expect(model.calls).toBe(2)
  })
})

const entry = (id: number, kind: string, text: string): EntryRecord => ({
  id: entryId(id),
  conversationId: conversationId('1'),
  kind,
  model: [{ role: 'user', content: text, timestamp: 1 }],
})

describe("main's verbatim tail (unit)", () => {
  it('counts what the model reads after the view, not the view itself', () => {
    const words = entry(2, 'pi.user', 'w'.repeat(4000))
    const view = entry(3, 'app.memory', 'v'.repeat(40_000))
    expect(tailTokens([words, view])).toBe(tailTokens([words]))
    expect(tailTokens([words])).toBeGreaterThan(500)
    expect(tailTokens([])).toBe(0)
  })
})
