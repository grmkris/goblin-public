import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'

/** The instance clock in epoch seconds, as Topics, Personas, receipts and invocations keep time. */
export const nowSeconds: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)
