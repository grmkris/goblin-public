import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

/**
 * At most one run of a keyed piece of work at a time, across waits: a token refresh, a connect, a move's remaining
 * steps. The first caller forks the work in the layer's scope and every caller (the first among them) joins it, so
 * they all get its one value or its one failure, and interrupting a caller ends only its wait. The key is free again
 * once the work ends. `KeyedLock` is the other primitive: it orders admissions and is never held across a wait.
 */
export class SingleFlight extends Context.Service<
  SingleFlight,
  {
    /** Joins the run in flight under `key`, or starts `effect` as it. */
    readonly run: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    /** `Option.none()` at once when a run is in flight under `key`; otherwise starts `effect` as it and joins it. */
    readonly skip: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>
  }
>()('goblin/observability/SingleFlight') {
  static readonly layer = Layer.effect(
    SingleFlight,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      /** Each key's run in flight, as the `Deferred` its callers await. */
      const flights = new Map<string, unknown>()
      /**
       * The run in flight under `key`, else a new one forked in the layer's scope. The key is taken before the fork
       * and freed by the forked fiber's own exit (even one interrupted before it started), and this step is
       * uninterruptible, so a key is never held with no work behind it.
       */
      const flight = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            const current = flights.get(key)
            if (current !== undefined) {
              // SAFETY: every caller of a key passes the same work, so the run in flight has this caller's types.
              return Effect.succeed(current as Deferred.Deferred<A, E>)
            }
            const done = Deferred.makeUnsafe<A, E>()
            flights.set(key, done)
            return Effect.map(Effect.forkIn(effect, scope), (fiber) => {
              fiber.addObserver((exit) => {
                flights.delete(key)
                Deferred.doneUnsafe(done, exit)
              })
              return done
            })
          }),
        )
      const run = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(flight(key, effect), Deferred.await)
      return SingleFlight.of({
        run,
        skip: (key, effect) =>
          Effect.suspend(() => (flights.has(key) ? Effect.succeedNone : Effect.map(run(key, effect), Option.some))),
      })
    }),
  )
}
