import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'

/** The Clock's time in epoch seconds, the unit rows, grants, budgets and resident authority are kept in. */
export const epochSeconds: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)
/** Wall-clock seconds for token and grant expiry checks at the plain-async edges. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000)
/** Wall-clock milliseconds for durations in plain-async log lines. */
export const nowMillis = (): number => Date.now()
