import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { EXPECTED_ERROR_TAGS, reportAndRecover, safeErrorType } from './report.ts'

/**
 * Where conversation flows are recorded (ADR 0024): one content-free `FlowEvent` per step of a reply, a thread start,
 * a move, a Persona or Delegate. Recording never fails the flow it describes; a sink failure is reported instead.
 */
export class FlowEvents extends Context.Service<
  FlowEvents,
  { readonly record: (event: FlowEvent) => Effect.Effect<void> }
>()('goblin/observability/FlowEvents') {
  /** Records each event through `sink` (the run ledger, Analytics Engine). */
  static layerWith<E>(sink: (event: FlowEvent) => Effect.Effect<void, E>): Layer.Layer<FlowEvents> {
    return Layer.succeed(
      FlowEvents,
      FlowEvents.of({
        record: Effect.fn('FlowEvents.record')(function* (event: FlowEvent) {
          yield* Effect.suspend(() => sink(event)).pipe(reportAndRecover('flows.record', undefined))
        }),
      }),
    )
  }

  /** Records `event` through the agent's flows. */
  static readonly record = (event: FlowEvent): Effect.Effect<void, never, FlowEvents> =>
    FlowEvents.use((flows) => flows.record(event))

  /** Records nothing, for tests that do not look at flows. */
  static readonly noop: Layer.Layer<FlowEvents> = Layer.succeed(
    FlowEvents,
    FlowEvents.of({ record: () => Effect.void }),
  )
}

/**
 * How a flow that failed with `error` ended: `refused` for a typed refusal the caller is answered with (a 404, a 409),
 * `error` for anything else. Only the failure's type is kept, never its text.
 */
export const failedFlow = (error: unknown): Pick<FlowEvent, 'status' | 'errorType'> => {
  const errorType = safeErrorType(error)
  return { status: EXPECTED_ERROR_TAGS.has(errorType) ? 'refused' : 'error', errorType }
}

/**
 * Records `flow` once `effect` ends: `ok` with what `settled` reads from its value (a replay, a count, the chat it
 * made), or how it failed (`failedFlow`). Recording never fails the flow it describes.
 */
export const withFlow =
  <A>(flow: Omit<FlowEvent, 'status' | 'errorType'>, settled: (value: A) => Partial<FlowEvent> = () => ({})) =>
  <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | FlowEvents> =>
    effect.pipe(
      Effect.tap((value) => FlowEvents.record({ ...flow, status: 'ok', ...settled(value) })),
      Effect.tapError((error) => FlowEvents.record({ ...flow, ...failedFlow(error) })),
    )
