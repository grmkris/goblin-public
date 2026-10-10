import { describe, expect, it } from '@effect/vitest'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import { Conflict, Internal } from '../../src/http/errors.ts'
import { FlowEvents, failedFlow, withFlow } from '../../src/observability/flows.ts'
import { ReporterLive } from '../../src/observability/report.ts'
import { withLines } from './lines.ts'

const reply: FlowEvent = { flow: 'reply', via: 'app', actor: 'owner', chat: '12', status: 'ok' }

describe('flow events', () => {
  it.effect('records each event through the sink', () =>
    Effect.gen(function* () {
      const recorded: FlowEvent[] = []
      const flows = FlowEvents.layerWith((event) => Effect.sync(() => recorded.push(event)))
      yield* FlowEvents.record(reply).pipe(Effect.provide(flows))
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
          yield* FlowEvents.record(reply).pipe(Effect.provide(failing))
          yield* FlowEvents.record(reply).pipe(Effect.provide(throwing))
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(lines.map(({ line }) => [line['where'], line['error.type']])).toEqual([
        ['flows.record', 'Internal'],
        ['flows.record', 'TypeError'],
      ])
    }),
  )

  it.effect('records nothing with the noop layer', () => FlowEvents.record(reply).pipe(Effect.provide(FlowEvents.noop)))

  it.effect('withFlow records ok with what the value settles, or how the effect failed', () =>
    Effect.gen(function* () {
      const recorded: FlowEvent[] = []
      const flows = FlowEvents.layerWith((event) => Effect.sync(() => recorded.push(event)))
      const flow = { flow: 'close', via: 'app', actor: 'owner', chat: '12' } as const
      const closed = yield* Effect.succeed(2).pipe(
        withFlow(flow, (count) => ({ count })),
        Effect.provide(flows),
      )
      expect(closed).toBe(2)
      yield* Effect.succeed(0).pipe(
        withFlow(flow, (count) => ({ count, status: 'replayed' })),
        Effect.provide(flows),
      )
      const refused = yield* Effect.fail(new Conflict({ reason: 'touched' })).pipe(
        withFlow(flow),
        Effect.provide(flows),
        Effect.flip,
      )
      expect(refused).toBeInstanceOf(Conflict)
      // expected: only the recorded flow is checked here
      yield* Effect.fail(new Internal({ reason: 'x' })).pipe(withFlow(flow), Effect.provide(flows), Effect.ignore)
      expect(recorded).toEqual([
        { ...flow, count: 2, status: 'ok' },
        { ...flow, count: 0, status: 'replayed' },
        { ...flow, status: 'refused', errorType: 'Conflict' },
        { ...flow, status: 'error', errorType: 'Internal' },
      ])
    }),
  )

  it('failedFlow keeps only the failure type: refused for an answered refusal, error for anything else', () => {
    expect(failedFlow(new Conflict({ reason: 'secret' }))).toEqual({ status: 'refused', errorType: 'Conflict' })
    expect(failedFlow(new TypeError('secret'))).toEqual({ status: 'error', errorType: 'TypeError' })
  })
})
