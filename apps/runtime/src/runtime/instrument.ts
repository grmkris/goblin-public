import type * as Effect from 'effect/Effect'

/**
 * Wraps each program the bridge runs and each change handler the Changes bus runs. The identity for now; the conductor
 * sets it (agent.ts, `AgentInput.instrument`) to add error reporting and log annotations, so both see a failure.
 */
export type Instrument = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

export const uninstrumented: Instrument = (effect) => effect
