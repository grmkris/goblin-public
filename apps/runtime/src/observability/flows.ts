import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { reportAndRecover } from './report.ts'

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

  /** Records nothing, for tests that do not look at flows. */
  static readonly noop: Layer.Layer<FlowEvents> = Layer.succeed(
    FlowEvents,
    FlowEvents.of({ record: () => Effect.void }),
  )
}
