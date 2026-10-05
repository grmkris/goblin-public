import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import { Type } from '@earendil-works/pi-ai'
import type { Delivery, ReplayEvent, RetrievalRecord } from '../src/protocol.ts'
import { archiveRead, archiveSearch, type RetrievalOutput } from './archive.ts'
import { byteLength } from './sources.ts'

/** One shared allowance for zoom/search/read; denied and unavailable calls consume call allowance. */
export class Retrieval {
  readonly trace: RetrievalRecord[] = []
  readonly deliveries: Delivery[] = []
  #used = 0
  readonly calls: number
  readonly maxBytes: number
  constructor(calls: number, maxBytes: number) {
    this.calls = calls
    this.maxBytes = maxBytes
  }

  async get(operation: RetrievalRecord['operation'], read: () => Promise<RetrievalOutput>): Promise<string> {
    if (this.trace.length >= this.calls) return this.#deny(operation, 'Retrieval call limit reached.')
    const output = await read()
    if (byteLength(output.text) + this.#used > this.maxBytes)
      return this.#deny(operation, 'Retrieval byte limit reached.')
    this.#used += byteLength(output.text)
    this.deliveries.push(...output.deliveries)
    this.trace.push({ operation, text: output.text, denied: output.unavailable ?? false })
    return output.text
  }
  #deny(operation: RetrievalRecord['operation'], text: string) {
    this.trace.push({ operation, text: '', denied: true })
    return text
  }
}

/** Fixed original archive prefix; no access to main, future events or evaluator labels. */
export function searchExtension(
  archive: () => readonly ReplayEvent[],
  use: (
    operation: RetrievalRecord['operation'],
    read: () => Promise<RetrievalOutput>,
    conversation: string,
  ) => Promise<string>,
) {
  return defineExtension({
    name: 'bench.search',
    tools: [
      defineTool({
        name: 'archive_search',
        description:
          'Find up to four bounded original excerpts by lexical terms, including recorded tool filenames. Results include source IDs and byte ranges; archive_read opens more of a source.',
        parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
        replay: 'safe',
        execute: async ({ query }, api) => ({
          content: [
            {
              type: 'text',
              text: await use(
                'archive_search',
                async () => archiveSearch(archive(), query),
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
                async () => archiveRead(archive(), id, offsetBytes, maxBytes),
                String(api.conversationId),
              ),
            },
          ],
        }),
      }),
    ],
  })
}
