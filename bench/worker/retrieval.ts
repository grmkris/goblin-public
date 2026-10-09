import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { Delivery, ReplayEvent, RetrievalRecord } from '../src/protocol.ts'
import { archiveRead, archiveSearch, type RetrievalOutput } from './archive.ts'
import { byteLength } from './sources.ts'

export type RetrievalAllowance = { readonly maxBytes: number; readonly compact: boolean }
export type RetrievalRead = (allowance: RetrievalAllowance) => Promise<RetrievalOutput>

/** One shared allowance for zoom/search/read; denied and unavailable calls consume call allowance. */
export class Retrieval {
  readonly trace: RetrievalRecord[] = []
  readonly deliveries: Delivery[] = []
  #used = 0
  readonly calls: number
  readonly maxBytes: number
  readonly compact: boolean
  constructor(calls: number, maxBytes: number, compact = false) {
    this.calls = calls
    this.maxBytes = maxBytes
    this.compact = compact
  }

  async get(operation: RetrievalRecord['operation'], read: RetrievalRead): Promise<string> {
    if (this.trace.length >= this.calls) return this.#deny(operation, 'Retrieval call limit reached.')
    const output = await read({
      maxBytes: Math.max(0, this.maxBytes - this.#used - (this.compact ? 100 : 0)),
      compact: this.compact,
    })
    const text = this.compact ? this.#envelope(output.text) : output.text
    if (byteLength(text) + this.#used > this.maxBytes) return this.#deny(operation, 'Retrieval byte limit reached.')
    this.#used += byteLength(text)
    this.deliveries.push(...output.deliveries)
    this.trace.push({ operation, text, denied: output.unavailable ?? false })
    return text
  }
  #envelope(text: string) {
    let result: unknown = text
    try {
      result = JSON.parse(text)
    } catch {
      // expected: plain availability messages are legitimate retrieval output too
    }
    const envelope = (remainingBytes: number) =>
      JSON.stringify({ result, remainingCalls: Math.max(0, this.calls - this.trace.length - 1), remainingBytes })
    let remaining = this.maxBytes - this.#used
    // Metadata is charged too. Iterate until the decimal byte counter stabilizes.
    for (let step = 0; step < 8; step += 1) {
      const next = Math.max(0, this.maxBytes - this.#used - byteLength(envelope(remaining)))
      if (next === remaining) return envelope(remaining)
      remaining = next
    }
    return envelope(remaining)
  }
  #deny(operation: RetrievalRecord['operation'], text: string) {
    this.trace.push({ operation, text: '', denied: true })
    return text
  }
}

/** Fixed original archive prefix; no access to main, future events or evaluator labels. */
export function searchExtension(
  archive: () => readonly ReplayEvent[],
  use: (operation: RetrievalRecord['operation'], read: RetrievalRead, conversation: string) => Promise<string>,
) {
  return defineExtension({
    name: 'bench.search',
    tools: [
      defineTool({
        name: 'archive_search',
        description:
          'Find bounded original excerpts by lexical terms, including recorded tool filenames. Results include source IDs, exact byte ranges and continuation offsets; archive_read opens more. Compact responses contain at most two matches and report remaining allowance.',
        parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
        replay: 'safe',
        execute: async ({ query }, api) => ({
          content: [
            {
              type: 'text',
              text: await use(
                'archive_search',
                async (allowance) => archiveSearch(archive(), query, allowance),
                String(api.conversationId),
              ),
            },
          ],
        }),
      }),
      defineTool({
        name: 'archive_read',
        description:
          'Read an authorized original source by ID. Optional offsetBytes continues at nextOffsetBytes. maxBytes caps the entire serialized response at 2048 bytes including metadata; default 2048.',
        parameters: Type.Object({
          id: Type.String({ minLength: 1 }),
          offsetBytes: Type.Optional(Type.Integer({ minimum: 0 })),
          maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 2048 })),
        }),
        replay: 'safe',
        execute: async ({ id, offsetBytes, maxBytes }, api) => ({
          content: [
            {
              type: 'text',
              text: await use(
                'archive_read',
                async (allowance) =>
                  archiveRead(
                    archive(),
                    id,
                    offsetBytes,
                    Math.min(maxBytes ?? 2048, allowance.maxBytes),
                    allowance.compact,
                  ),
                String(api.conversationId),
              ),
            },
          ],
        }),
      }),
    ],
  })
}
