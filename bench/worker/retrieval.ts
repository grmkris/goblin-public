import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { ReplayEvent } from '../src/protocol.ts'

const bytes = (text: string) => new TextEncoder().encode(text).length
/** Per-probe allowance; even denied calls count. Return complete records, never split UTF-8 or source markers. */
export class Retrieval {
  readonly trace: { text: string; denied: boolean }[] = []
  #used = 0
  readonly calls: number
  readonly maxBytes: number
  constructor(calls: number, maxBytes: number) {
    this.calls = calls
    this.maxBytes = maxBytes
  }

  async get(read: () => Promise<string>): Promise<string> {
    if (this.trace.length >= this.calls) {
      this.trace.push({ text: '', denied: true })
      return 'Retrieval call limit reached.'
    }
    const text = await read()
    if (bytes(text) + this.#used > this.maxBytes) {
      this.trace.push({ text: '', denied: true })
      return 'Retrieval byte limit reached.'
    }
    this.#used += bytes(text)
    this.trace.push({ text, denied: false })
    return text
  }
}

/** A lexical control with a fixed archive prefix, no access to main, future events or the evaluator ledger. */
export function searchExtension(
  archive: () => readonly ReplayEvent[],
  use: (read: () => Promise<string>) => Promise<string>,
) {
  return defineExtension({
    name: 'bench.search',
    tools: [
      defineTool({
        name: 'archive_search',
        description: 'Find source events in the authorized archive prefix using lexical terms.',
        parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
        replay: 'safe',
        execute: async ({ query }) => {
          const events = archive()
          const terms = query.toLowerCase().split(/\W+/u).filter(Boolean)
          const matches = events
            .map((event) => ({ event, score: terms.filter((term) => event.text.toLowerCase().includes(term)).length }))
            .filter(({ score }) => score > 0)
            .toSorted((a, b) => b.score - a.score || events.indexOf(b.event) - events.indexOf(a.event))
            .slice(0, 4)
            .map(({ event }) => `[source:${event.id}] ${event.kind}: ${event.text}`)
            .join('\n')
          return { content: [{ type: 'text', text: await use(async () => matches || 'No matching source events.') }] }
        },
      }),
    ],
  })
}
