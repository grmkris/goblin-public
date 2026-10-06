import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

/** Real workerd app metadata, with a forced object restart after writes. */
export function homeCase(url: string) {
  return Effect.gen(function* () {
    const base = url.replace(/\/+$/u, '')
    const name = `home-${Date.now()}`
    const response = yield* Effect.promise(() => fetch(`${base}/home-probe?name=${name}`))
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      first: { kind: 'applied', layout: { revision: 1 } },
      replay: { kind: 'applied', layout: { revision: 1 } },
      stale: { kind: 'stale', layout: { revision: 1 } },
      ownerTile: { kind: 'applied', layout: { revision: 2 } },
      asked: { kind: 'owner-required', tileIds: ['recent'] },
      atomicAsk: true,
      changed: { kind: 'applied', layout: { revision: 3 } },
      undo: {
        kind: 'applied',
        layout: {
          revision: 4,
          tiles: [
            expect.objectContaining({ id: 'today', size: 'medium' }),
            expect.objectContaining({ id: 'recent', placedBy: 'owner' }),
          ],
        },
      },
      invalid: true,
      atomicInvalid: true,
      bounded: true,
      utf8: true,
      duplicate: true,
      eight: true,
      closePreserved: true,
      erased: true,
      agentMcpReason: 'Only the owner pins MCP Apps on Home',
      ownerMcp: {
        kind: 'applied',
        layout: {
          revision: 7,
          tiles: expect.arrayContaining([expect.objectContaining({ id: 'mcp-board', placedBy: 'owner' })]),
        },
      },
      afterClose: { kind: 'applied', layout: { revision: 8 } },
      closedAddRejected: true,
      afterThreadClose: { kind: 'applied', layout: { revision: 10 } },
      threadClosed: true,
      retained: { revision: 10 },
    })
    yield* Effect.promise(() => fetch(`${base}/routine-evict?name=${name}`).catch(() => undefined))
    const restored = yield* Effect.promise(() => fetch(`${base}/home-retained?name=${name}`).then((res) => res.json()))
    expect(restored).toMatchObject({
      revision: 10,
      tiles: [
        expect.objectContaining({ id: 'today' }),
        expect.objectContaining({ id: 'recent' }),
        expect.objectContaining({ id: 'mcp-board', placedBy: 'owner' }),
        expect.objectContaining({ id: 'thread-board', placedBy: 'owner' }),
      ],
    })
  })
}
