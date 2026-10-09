import { describe, expect, it } from '@effect/vitest'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { AGENT_HASH_INFO, agentHash, flowAnalytics, flowPoint } from '../../src/observability/ae.ts'

/** 32 bytes, base64, as CREDENTIAL_KEY is. */
const KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)))
const OTHER_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, index) => 255 - index)))

const reply: FlowEvent = {
  flow: 'reply',
  via: 'app',
  actor: 'owner',
  chat: '412',
  parentChat: '1',
  topic: 3,
  operationId: 'owner:op-73',
  parentOperation: 'owner:op-72',
  count: 2,
  personaOrder: 'sequence',
  status: 'ok',
  ms: 41,
}

/** An Analytics Engine dataset that keeps what it was given. */
const dataset = () => {
  const points: AnalyticsEngineDataPoint[] = []
  return { points, binding: { writeDataPoint: (point?: AnalyticsEngineDataPoint) => void points.push(point ?? {}) } }
}

describe('flow points for Analytics Engine', () => {
  it.effect('hash the agent stably, per key and label, to 16 hex characters', () =>
    Effect.gen(function* () {
      const hash = yield* agentHash(KEY, 'user-1')
      expect(hash).toMatch(/^[0-9a-f]{16}$/u)
      expect(yield* agentHash(KEY, 'user-1', AGENT_HASH_INFO)).toBe(hash)
      expect(yield* agentHash(KEY, 'user-2')).not.toBe(hash)
      expect(yield* agentHash(OTHER_KEY, 'user-1')).not.toBe(hash)
      expect(yield* agentHash(KEY, 'user-1', 'goblin/flows/agent-v2')).not.toBe(hash)
    }),
  )

  it('lay a step out as indexes, blobs and doubles, with no chat or operation id', () => {
    const point = flowPoint(reply, 'abcdef0123456789', { stage: 'dev', build: 'b1' })
    expect(point).toEqual({
      indexes: ['abcdef0123456789'],
      blobs: ['reply', 'app', 'owner', '', 'ok', '', 'dev', 'b1', 'sequence'],
      doubles: [1, 2, 41, 1],
    })
    const written = JSON.stringify(point)
    for (const id of ['412', 'owner:op-73', 'owner:op-72']) expect(written).not.toContain(id)
  })

  it.effect('write one point per operation, every step without one, and nothing without the binding', () =>
    Effect.gen(function* () {
      const { points, binding } = dataset()
      const write = yield* flowAnalytics({ FLOWS: binding, CREDENTIAL_KEY: KEY, STAGE: 'dev' }, 'user-1')
      yield* write(reply)
      yield* write({ ...reply, status: 'error', errorType: 'Internal' })
      const { operationId: _operation, ...unkeyed } = reply
      yield* write(unkeyed)
      yield* write(unkeyed)
      expect(points.map((point) => point.blobs?.[4])).toEqual(['ok', 'ok', 'ok'])
      expect(points[0]?.indexes).toEqual([yield* agentHash(KEY, 'user-1')])

      const none = yield* flowAnalytics({ CREDENTIAL_KEY: KEY, STAGE: 'dev' }, 'user-1')
      yield* none(reply)
      expect(points).toHaveLength(3)
    }),
  )
})
