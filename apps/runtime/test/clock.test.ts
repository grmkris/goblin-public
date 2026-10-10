import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { epochSeconds } from '../src/clock.ts'

describe('clock', () => {
  it.effect('epochSeconds is the Clock in whole seconds, rounded down', () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(86_400_999)
      expect(yield* epochSeconds).toBe(86_400)
      yield* TestClock.adjust('1 millis')
      expect(yield* epochSeconds).toBe(86_401)
    }),
  )
})
