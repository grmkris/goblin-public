import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { KeyedLock } from '../../src/observability/lock.ts'
import { eventually } from './lines.ts'

/** Forks `effect` under the lock for `key` and lets it take its ticket before returning. */
const queued = <A, E>(key: string, effect: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const lock = yield* KeyedLock
    const fiber = yield* lock.withLock(key)(effect).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    return fiber
  })

describe('keyed lock', () => {
  it.effect('serves 20 concurrent takers of one key in the order they came', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const order: number[] = []
      const holder = yield* queued('chat:1', Deferred.await(gate))
      const takers = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          queued(
            'chat:1',
            Effect.gen(function* () {
              order.push(index)
              // A taker that yields while holding still keeps the next one out.
              yield* Effect.yieldNow
              order.push(index)
            }),
          ),
      )
      expect(order).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      // A newcomer as the key frees up still queues behind everyone who came before it.
      const late = yield* queued(
        'chat:1',
        Effect.sync(() => order.push(99)),
      )
      yield* Fiber.join(holder)
      yield* Fiber.joinAll([...takers, late])
      expect(order).toEqual([...Array.from({ length: 20 }, (_, index) => [index, index]).flat(), 99])
    }).pipe(Effect.provide(KeyedLock.layer)),
  )

  it.effect('lets the next taker wait for the holder when a waiter between them is interrupted', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const order: string[] = []
      const holder = yield* queued(
        'chat:1',
        Deferred.await(gate).pipe(Effect.andThen(Effect.sync(() => order.push('holder')))),
      )
      const waiter = yield* queued(
        'chat:1',
        Effect.sync(() => order.push('waiter')),
      )
      const next = yield* queued(
        'chat:1',
        Effect.sync(() => order.push('next')),
      )
      yield* Fiber.interrupt(waiter)
      yield* eventually(() => order.length > 0, 20)
      expect(order).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(holder)
      yield* Fiber.join(next)
      expect(order).toEqual(['holder', 'next'])
    }).pipe(Effect.provide(KeyedLock.layer)),
  )

  it.effect('hands the key on when its holder is interrupted or fails', () =>
    Effect.gen(function* () {
      const order: string[] = []
      const stuck = yield* queued('chat:1', Effect.never)
      const failing = yield* queued('chat:1', Effect.fail('refused'))
      const next = yield* queued(
        'chat:1',
        Effect.sync(() => order.push('next')),
      )
      yield* Fiber.interrupt(stuck)
      expect(yield* Effect.flip(Fiber.join(failing))).toBe('refused')
      yield* Fiber.join(next)
      expect(order).toEqual(['next'])
    }).pipe(Effect.provide(KeyedLock.layer)),
  )

  it.effect('runs different keys at the same time', () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const holder = yield* queued('chat:1', Deferred.await(gate))
      const other = yield* queued('chat:2', Effect.succeed('done'))
      expect(yield* Fiber.join(other)).toBe('done')
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(holder)
    }).pipe(Effect.provide(KeyedLock.layer)),
  )

  it.effect('takes the same key again after everyone let go', () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock
      expect(yield* lock.withLock('chat:1')(Effect.succeed(1))).toBe(1)
      expect(yield* lock.withLock('chat:1')(Effect.succeed(2))).toBe(2)
    }).pipe(Effect.provide(KeyedLock.layer)),
  )
})
