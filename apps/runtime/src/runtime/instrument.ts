import * as Effect from 'effect/Effect'

/**
 * Wraps each program the bridge runs and each change handler the Changes bus runs (agent.ts,
 * `AgentInput.instrument`).
 */
export type Instrument = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>

export const uninstrumented: Instrument = (effect) => effect

/**
 * Reports what a program ends with to the agent's failure reporter (observability/report.ts): an `Internal` failure or
 * a defect, with the code location it came from. The typed failures an owner sees are expected and skipped there.
 */
export const reported: Instrument = (effect) => Effect.withErrorReporting(effect)
