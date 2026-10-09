import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as RcMap from 'effect/RcMap'
import * as Scope from 'effect/Scope'

/** A key's queue, as the turn the next taker waits for: the last ticket taken. */
type Queue = { last: Deferred.Deferred<void> }

/** One taker's place: the turn before it, and its own turn, which it hands on when it is done. */
type Ticket = {
  readonly previous: Deferred.Deferred<void>
  readonly own: Deferred.Deferred<void>
  held: boolean
}

const free = (): Deferred.Deferred<void> => {
  const turn = Deferred.makeUnsafe<void>()
  Deferred.doneUnsafe(turn, Effect.void)
  return turn
}

/** Joins the queue synchronously, so takers are served in the order they took a ticket. */
const take = (queue: Queue): Ticket => {
  const ticket: Ticket = { previous: queue.last, own: Deferred.makeUnsafe<void>(), held: false }
  queue.last = ticket.own
  return ticket
}

/**
 * Hands the key on. A taker interrupted before its turn passes on its predecessor's turn instead, so whoever comes
 * next still waits for the current holder, and nobody waits for the interrupted one.
 */
const handOn = (ticket: Ticket): void => {
  Deferred.doneUnsafe(ticket.own, ticket.held ? Effect.void : Deferred.await(ticket.previous))
}

/**
 * Mutual exclusion per key, strictly first come, first served: Effect's `Semaphore` wakes waiters in no fixed order,
 * and admission depends on order (two sends to one chat, a move racing its repeat). Each key is a chain of turns in
 * an `RcMap` with no idle time to live, so a key nobody holds or waits for is gone. Hold it for admission only,
 * never across a model call or another wait.
 */
export class KeyedLock extends Context.Service<
  KeyedLock,
  {
    readonly withLock: (key: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()('goblin/observability/KeyedLock') {
  static readonly layer = Layer.effect(
    KeyedLock,
    Effect.gen(function* () {
      const queues = yield* RcMap.make({ lookup: (_key: string) => Effect.sync((): Queue => ({ last: free() })) })
      const withLock =
        (key: string) =>
        <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              const scope = yield* Scope.make()
              const queue = yield* RcMap.get(queues, key).pipe(Scope.provide(scope))
              return { scope, ticket: take(queue) }
            }),
            ({ ticket }) =>
              Deferred.await(ticket.previous).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    ticket.held = true
                  }),
                ),
                Effect.andThen(effect),
              ),
            ({ scope, ticket }) =>
              Effect.sync(() => handOn(ticket)).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
          )
      return KeyedLock.of({ withLock })
    }),
  )
}
