import { describe, expect, it } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import { Conflict } from '../../src/http/errors.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'

class Caller extends Context.Service<Caller, { readonly name: string }>()('test/single-flight/Caller') {}

/** Work that counts its starts and finishes only when `gate` opens. */
const gated = <A, E>(gate: Deferred.Deferred<A, E>) => {
  const counts = { started: 0, finished: 0 }
  const work = Effect.sync(() => {
    counts.started += 1
  }).pipe(
    Effect.andThen(Deferred.await(gate)),
    Effect.tap(() =>
      Effect.sync(() => {
        counts.finished += 1
      }),
    ),
  )
  return { counts, work }
}

/** Forks `effect` and lets it reach its first wait before returning. */
const started = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    yield* Effect.yieldNow
    yield* Effect.yieldNow
    return fiber
  })

describe('single flight', () => {
  it.effect('callers of one key join one run and share its value', () =>
    Effect.gen(function* () {
      const flights = yield* SingleFlight
      const gate = yield* Deferred.make<string>()
      const { counts, work } = gated(gate)
      const callers = yield* Effect.forEach([1, 2, 3], () => started(flights.run('token:a', work)))
      expect(counts.started).toBe(1)
      yield* Deferred.succeed(gate, 'rotated')
      expect(yield* Fiber.joinAll(callers)).toEqual(['rotated', 'rotated', 'rotated'])
      expect(counts).toEqual({ started: 1, finished: 1 })
    }).pipe(Effect.provide(SingleFlight.layer)),
  )

  it.effect('every caller gets the one failure', () =>
    Effect.gen(function* () {
      const flights = yield* SingleFlight
      const gate = yield* Deferred.make<string, Conflict>()
      const { counts, work } = gated(gate)
      const first = yield* started(flights.run('token:a', work))
      const second = yield* started(flights.run('token:a', work))
      const failure = new Conflict({ reason: 'refresh refused' })
      yield* Deferred.fail(gate, failure)
      const exits = [yield* Fiber.await(first), yield* Fiber.await(second)]
      for (const exit of exits) expect(exit).toStrictEqual(Exit.fail(failure))
      expect(counts.started).toBe(1)
    }).pipe(Effect.provide(SingleFlight.layer)),
  )

  it.effect('interrupting the first caller ends only its wait, never the shared run', () =>
    Effect.gen(function* () {
      const flights = yield* SingleFlight
      const gate = yield* Deferred.make<string>()
      const { counts, work } = gated(gate)
      const first = yield* started(flights.run('token:a', work))
      const second = yield* started(flights.run('token:a', work))
      yield* Fiber.interrupt(first)
      yield* Deferred.succeed(gate, 'rotated')
      expect(yield* Fiber.join(second)).toBe('rotated')
      expect(counts).toEqual({ started: 1, finished: 1 })
    }).pipe(Effect.provide(SingleFlight.layer)),
  )

  it.effect('the key is free once the run ends, and other keys never wait for it', () =>
    Effect.gen(function* () {
      const flights = yield* SingleFlight
      let runs = 0
      const work = Effect.sync(() => ++runs)
      expect(yield* flights.run('token:a', work)).toBe(1)
      expect(yield* flights.run('token:a', work)).toBe(2)
      const gate = yield* Deferred.make<string>()
      const held = yield* started(flights.run('token:a', Deferred.await(gate)))
      expect(yield* flights.run('token:b', Effect.succeed('b'))).toBe('b')
      yield* Deferred.succeed(gate, 'a')
      expect(yield* Fiber.join(held)).toBe('a')
      const failed = yield* Effect.exit(flights.run('token:a', Effect.fail(new Conflict({ reason: 'no' }))))
      expect(Exit.isFailure(failed)).toBe(true)
      expect(yield* flights.run('token:a', work)).toBe(3)
    }).pipe(Effect.provide(SingleFlight.layer)),
  )

  it.effect('skip returns at once while a run is in flight, and runs once it is not', () =>
    Effect.gen(function* () {
      const flights = yield* SingleFlight
      const gate = yield* Deferred.make<string>()
      const { counts, work } = gated(gate)
      const naming = yield* started(flights.skip('naming:7', work))
      expect(yield* flights.skip('naming:7', work)).toStrictEqual(Option.none())
      expect(counts.started).toBe(1)
      yield* Deferred.succeed(gate, 'Trip plans')
      expect(yield* Fiber.join(naming)).toStrictEqual(Option.some('Trip plans'))
      expect(yield* flights.skip('naming:7', Effect.succeed('again'))).toStrictEqual(Option.some('again'))
    }).pipe(Effect.provide(SingleFlight.layer)),
  )

  it.effect('the run sees the services of the caller that started it', () =>
    Effect.gen(function* () {
      const flights = yield* SingleFlight
      const name = yield* flights.run(
        'caller',
        Caller.use((caller) => Effect.succeed(caller.name)),
      )
      expect(name).toBe('owner')
    }).pipe(Effect.provideService(Caller, { name: 'owner' }), Effect.provide(SingleFlight.layer)),
  )
})
