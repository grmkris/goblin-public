import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { evict, freshName, probeOf } from './native-case.ts'

/** Real workerd app metadata, with a forced object restart after writes. */
export async function homeChecks(base: string): Promise<void> {
  const name = freshName('home')
  const result = await probeOf(base, 'home', Schema.Unknown, name)
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
  await evict(base, name)
  const restored = await probeOf(base, 'home-retained', Schema.Unknown, name)
  expect(restored).toMatchObject({
    revision: 10,
    tiles: [
      expect.objectContaining({ id: 'today' }),
      expect.objectContaining({ id: 'recent' }),
      expect.objectContaining({ id: 'mcp-board', placedBy: 'owner' }),
      expect.objectContaining({ id: 'thread-board', placedBy: 'owner' }),
    ],
  })
}
