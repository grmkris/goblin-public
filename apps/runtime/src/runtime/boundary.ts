import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'

/**
 * Runs `effect` with `context` as a Promise, for a foreign callback wired inside a layer (the MCP SDK's auth provider
 * and dispatch guards, the skills guard). It rejects with the failure itself (`Effect.runPromiseWith` squashes the
 * cause to its first typed failure, else its defect), so a typed `AppError` crosses the foreign code unchanged.
 */
export const promiseWith =
  <R>(context: Context.Context<R>) =>
  <A, E>(effect: Effect.Effect<A, E, R>): Promise<A> =>
    Effect.runPromiseWith(context)(effect)

/**
 * `effect` with the services of the program that makes it, to hand to Promise code that runs it later (the MCP
 * manager's dispatch guard, the skills guard): it needs nothing more, so that code runs it with `promiseWith` and an
 * empty context.
 */
export const bound = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<Effect.Effect<A, E>, never, R> =>
  Effect.map(Effect.context<R>(), (context) => Effect.provideContext(effect, context))
