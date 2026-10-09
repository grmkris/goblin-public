import { describe, expect, it } from '@effect/vitest'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { Internal } from '../../src/http/errors.ts'
import { FlowEvents } from '../../src/observability/flows.ts'
import { ReporterLive } from '../../src/observability/report.ts'
import { withLines } from './lines.ts'

const reply: FlowEvent = { flow: 'reply', via: 'app', actor: 'owner', chat: '12', status: 'ok' }

describe('flow events', () => {
  it.effect('records each event through the sink', () =>
    Effect.gen(function* () {
      const recorded: FlowEvent[] = []
      const flows = FlowEvents.layerWith((event) => Effect.sync(() => recorded.push(event)))
      yield* FlowEvents.use((events) => events.record(reply)).pipe(Effect.provide(flows))
      expect(recorded).toEqual([reply])
    }),
  )

  it.effect('never fails the flow: a failing or throwing sink is reported instead', () =>
    Effect.gen(function* () {
      const failing = FlowEvents.layerWith(() => Effect.fail(new Internal({ reason: 'ledger' })))
      const throwing = FlowEvents.layerWith((): Effect.Effect<void> => {
        throw new TypeError('sink bug')
      })
      const { lines } = yield* withLines(
        Effect.gen(function* () {
          yield* FlowEvents.use((events) => events.record(reply)).pipe(Effect.provide(failing))
          yield* FlowEvents.use((events) => events.record(reply)).pipe(Effect.provide(throwing))
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(lines.map(({ line }) => [line['where'], line['error.type']])).toEqual([
        ['flows.record', 'Internal'],
        ['flows.record', 'TypeError'],
      ])
    }),
  )

  it.effect('records nothing with the noop layer', () =>
    FlowEvents.use((events) => events.record(reply)).pipe(Effect.provide(FlowEvents.noop)),
  )
})
