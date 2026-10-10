import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

/**
 * Runs `effect` to its end at once, on the caller's stack, with `context` (the services of the layer that captured it):
 * for telling the change bus (`Changes`, whose handlers run inline and never wait) from the synchronous code of a
 * Promise class, which has no fiber to yield to. Never for work that waits: an asynchronous step is a defect there.
 */
export const syncWith =
  <R>(context: Context.Context<R>) =>
  <A, E>(effect: Effect.Effect<A, E, R>): A =>
    Effect.runSyncWith(context)(effect)

/**
 * Runs `effect` with `context` as a Promise, for a foreign callback wired inside a layer (the MCP SDK's auth provider
 * and dispatch guards, the skills guard). It rejects with the failure itself (`Effect.runPromiseWith` squashes the
 * cause to its first typed failure, else its defect), so a typed `AppError` crosses the foreign code unchanged.
 */
export const promiseWith =
  <R>(context: Context.Context<R>) =>
  <A, E>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromiseWith(context)(effect)
