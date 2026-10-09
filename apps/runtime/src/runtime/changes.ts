import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { AgentInput } from './input.ts'
import { type Instrument, uninstrumented } from './instrument.ts'

/**
 * The topics the runtime publishes, each with its payload. Empty here: a lane adds its topics from its own module by
 * declaration merging, so no two lanes edit one shared file:
 *
 *     declare module '../runtime/changes.ts' {
 *       interface ChangeTopics {
 *         'conversations.closed': { readonly ids: readonly string[] }
 *       }
 *     }
 *
 * Name a topic `<area>.<event>`. A payload carries identifiers, never content (ADR 0024).
 */
export interface ChangeTopics {}

/** One topic's handler. It may fail; the bus stops only that handler. */
export type ChangeHandler<Payload> = (payload: Payload) => Effect.Effect<void, unknown>

export interface ChangeBus<Topics> {
  /** Adds `handler` to `topic`, after the handlers already there. */
  readonly on: <K extends keyof Topics>(topic: K, handler: ChangeHandler<Topics[K]>) => Effect.Effect<void>
  /**
   * Runs `topic`'s handlers on `payload` inline, one after another in registration order, and returns when the last
   * is done. A handler added meanwhile runs from the next publish. A handler's failure (or defect) passes through
   * `instrument`, where the reporter sees it, and then ends only that handler; an interruption still interrupts.
   */
  readonly publish: <K extends keyof Topics>(topic: K, payload: Topics[K]) => Effect.Effect<void>
}

/** A synchronous topic bus: no fibers and no timers, so a publish inside a transaction stays inside it. */
export const makeChanges = <Topics = ChangeTopics>(instrument: Instrument = uninstrumented): ChangeBus<Topics> => {
  const handlers = new Map<keyof Topics, readonly ChangeHandler<unknown>[]>()
  const isolated = (handler: Effect.Effect<void, unknown>) =>
    Effect.catchCause(instrument(handler), (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.void))
  return {
    on: (topic, handler) =>
      Effect.sync(() => {
        // SAFETY: `publish` hands a topic's handlers only that topic's payload, the `Topics[K]` this one takes.
        handlers.set(topic, [...(handlers.get(topic) ?? []), handler as ChangeHandler<unknown>])
      }),
    publish: (topic, payload) =>
      Effect.suspend(() =>
        Effect.forEach(handlers.get(topic) ?? [], (handler) => isolated(Effect.suspend(() => handler(payload))), {
          discard: true,
        }),
      ),
  }
}

/** The agent's change bus, one per runtime. */
export class Changes extends Context.Service<Changes, ChangeBus<ChangeTopics>>()('goblin/runtime/Changes') {
  static readonly layer = Layer.effect(
    Changes,
    AgentInput.useSync((input) => makeChanges(input.instrument)),
  )
}
