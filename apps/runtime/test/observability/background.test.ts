import { describe, expect, it } from '@effect/vitest'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { Internal } from '../../src/http/errors.ts'
import { background } from '../../src/observability/background.ts'
import { ReporterLive } from '../../src/observability/report.ts'
import { eventually, withLines } from './lines.ts'

describe('background work', () => {
  it.effect('returns at once and reports a failure under its name', () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const { value: returned, lines } = yield* withLines(
        Effect.gen(function* () {
          yield* Deferred.await(started).pipe(
            Effect.andThen(Effect.fail(new Internal({ reason: 'x' }))),
            background('test.background'),
          )
          return 'returned'
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(returned).toBe('returned')
      expect(lines).toEqual([])
      yield* Deferred.succeed(started, undefined)
      yield* eventually(() => lines.length > 0)
      expect(lines.map(({ line }) => [line['event'], line['where'], line['error.type']])).toEqual([
        ['failure', 'test.background', 'Internal'],
      ])
    }),
  )

  it.effect('does not report an interruption', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        Effect.gen(function* () {
          yield* Effect.interrupt.pipe(background('test.interrupt'))
          yield* eventually(() => false, 10)
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(lines).toEqual([])
    }),
  )
})
