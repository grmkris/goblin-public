import { describe, expect, it } from '@effect/vitest'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Inspector } from '../src/inspect/inspector.ts'
import { Inspection } from '../src/inspect/service.ts'
import { InspectionAdapter } from '../src/layers/observability.ts'
import { Inspect } from '../src/services.ts'
import { flowRunEvent } from '../src/telemetry/events.ts'
import { RunLedger } from '../src/telemetry/ledger.ts'
import { chatDatabase } from './chats-sqlite.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 10 * DAY_MS
const reply: FlowEvent = { flow: 'reply', via: 'app', actor: 'owner', chat: '12', status: 'ok' }

/** `Inspection` as the agent provides it until the inspector is native: over the legacy one, on a real ledger. */
const fixture = () => {
  const { db, close } = chatDatabase()
  const ledger = new RunLedger(db)
  // SAFETY: nothing here lists conversations or reads Pi: flows are ledger rows, and no turn is ever found.
  const unread = undefined as never
  const inspector = new Inspector(ledger, unread, unread, () => NOW)
  const layer = InspectionAdapter.pipe(Layer.provide(Layer.succeed(Inspect, inspector)))
  return { ledger, layer, close }
}

describe('Inspection over the legacy inspector', () => {
  it.effect('answers each read as the inspector does', () => {
    const { ledger, layer, close } = fixture()
    ledger.ended(flowRunEvent(reply, 'flow:1', NOW - 10))
    return Effect.gen(function* () {
      const inspection = yield* Inspection
      expect(yield* inspection.flows({})).toEqual({ since: NOW - DAY_MS, flows: [{ ...reply, at: NOW - 10 }] })
      expect(yield* inspection.run({ kind: 'flows', chat: '7' })).toEqual({ since: NOW - DAY_MS, flows: [] })
      expect(yield* inspection.problems({})).toEqual({ since: NOW - DAY_MS, problems: [] })
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(close)))
  })

  it.effect('fails with the typed error a read refused with', () => {
    const { layer, close } = fixture()
    return Effect.gen(function* () {
      const inspection = yield* Inspection
      expect(yield* Effect.flip(inspection.turn('missing'))).toMatchObject({ _tag: 'NotFound', what: 'turn' })
      expect(yield* Effect.flip(inspection.details({ operation: 'missing' }))).toMatchObject({ _tag: 'NotFound' })
      expect(yield* Effect.flip(inspection.run({ kind: 'details', entry: 4 }))).toMatchObject({ _tag: 'InvalidInput' })
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(close)))
  })
})
