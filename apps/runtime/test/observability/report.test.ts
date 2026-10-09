import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import { BudgetExhausted, Conflict, GrantDenied, Internal, NotFound, UpstreamMcp } from '../../src/http/errors.ts'
import {
  EXPECTED_ERROR_TAGS,
  ReporterLive,
  expectedFailure,
  reportAndRecover,
  framesOf,
  reportFailure,
  safeErrorType,
} from '../../src/observability/report.ts'
import { withLines } from './lines.ts'

const SECRET = 'the owner wrote: please keep my diagnosis private'
const FRAME = /^at .*:\d+:\d+\)?$/u

const internal = Effect.fn('Probe.internal')(function* () {
  return yield* new Internal({ reason: SECRET })
})
const thrown = Effect.fn('Probe.thrown')(function* () {
  yield* Effect.void
  // A message that looks like stack frames must not pass as frames.
  throw new TypeError(`${SECRET}\n    at forged (evil.js:1:1)`)
})

describe('failure reporter', () => {
  it.effect('logs where, the type and stack locations, never the message', () =>
    Effect.gen(function* () {
      const { value, lines } = yield* withLines(
        internal().pipe(reportFailure('test.report'), Effect.exit, Effect.provide(ReporterLive)),
      )
      expect(Exit.isFailure(value)).toBe(true)
      expect(lines).toHaveLength(1)
      expect(lines[0]?.method).toBe('error')
      expect(lines[0]?.line).toMatchObject({
        level: 'error',
        event: 'failure',
        where: 'test.report',
        'error.type': 'Internal',
        severity: 'Error',
      })
      expect(lines[0]?.line['frames']).toEqual(expect.arrayContaining([expect.stringMatching(FRAME)]))
      expect(JSON.stringify(lines)).not.toContain('diagnosis')
    }),
  )

  it.effect('keeps only real frames of a defect whose message spans lines', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        thrown().pipe(reportFailure('test.defect'), Effect.exit, Effect.provide(ReporterLive)),
      )
      expect(lines).toHaveLength(1)
      expect(lines[0]?.line).toMatchObject({ 'error.type': 'TypeError', where: 'test.defect' })
      const serialized = JSON.stringify(lines)
      expect(serialized).not.toContain('diagnosis')
      expect(serialized).not.toContain('evil.js')
    }),
  )

  it.effect('does not report the typed failures a request ends with, only Internal and defects', () =>
    Effect.gen(function* () {
      const expected = [
        new NotFound({ what: 'x' }),
        new Conflict({ reason: 'x' }),
        new BudgetExhausted({ limit: 1, resetsAt: 2 }),
        new UpstreamMcp({ serverId: 's', reason: 'timeout' }),
      ]
      const { lines } = yield* withLines(
        Effect.gen(function* () {
          for (const error of expected) yield* Effect.exit(Effect.fail(error).pipe(reportFailure('typed')))
          yield* Effect.exit(Effect.fail(new Internal({ reason: 'x' })).pipe(reportFailure('internal')))
          yield* Effect.exit(Effect.die(new NotFound({ what: 'x' })).pipe(reportFailure('thrown')))
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(expected.every((error) => EXPECTED_ERROR_TAGS.has(error._tag))).toBe(true)
      expect(EXPECTED_ERROR_TAGS.has('Internal')).toBe(false)
      expect(lines.map(({ method, line }) => [method, line['where'], line['error.type']])).toEqual([
        ['error', 'internal', 'Internal'],
        ['error', 'thrown', 'NotFound'],
      ])
      expect(lines.every(({ line }) => Array.isArray(line['frames']) && line['frames'].length > 0)).toBe(true)
    }),
  )

  it.effect('lowers failures marked expected and skips the ones marked to skip', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        Effect.gen(function* () {
          yield* Effect.exit(Effect.fail(expectedFailure(new Internal({ reason: 'x' }))).pipe(reportFailure('a')))
          yield* Effect.exit(Effect.die(new BudgetExhausted({ limit: 1, resetsAt: 2 })).pipe(reportFailure('b')))
          yield* Effect.exit(
            Effect.fail(expectedFailure(new Internal({ reason: 'x' }), 'skip')).pipe(reportFailure('c')),
          )
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(lines.map(({ method, line }) => [method, line['where'], line['severity']])).toEqual([
        ['log', 'a', 'Info'],
        ['log', 'b', 'Info'],
      ])
    }),
  )

  it.effect('recovers with the fallback after reporting, and lets an interruption interrupt', () =>
    Effect.gen(function* () {
      const { value, lines } = yield* withLines(
        Effect.gen(function* () {
          const recovered = yield* internal().pipe(reportAndRecover('test.recover', 'fallback'))
          const interrupted = yield* Effect.exit(Effect.interrupt.pipe(reportAndRecover('test.interrupt', 'fallback')))
          return { recovered, interrupted }
        }).pipe(Effect.provide(ReporterLive)),
      )
      expect(value.recovered).toBe('fallback')
      expect(Exit.hasInterrupts(value.interrupted)).toBe(true)
      expect(lines.map(({ line }) => line['where'])).toEqual(['test.recover'])
    }),
  )

  it('names a failure by its tag or class, never by its fields or message', () => {
    expect(safeErrorType(new GrantDenied({ serverId: 's', name: 'create_note' }))).toBe('GrantDenied')
    expect(safeErrorType(new TypeError(SECRET))).toBe('TypeError')
    expect(safeErrorType({ _tag: SECRET })).toBe('Object')
    expect(safeErrorType(Object.create(null))).toBe('Error')
    expect(safeErrorType(SECRET)).toBe('Error')
  })

  it('skips a frame without a code location instead of the whole stack', () => {
    const error = new TypeError(SECRET)
    error.stack = [
      `TypeError: ${SECRET}`,
      '    at load (file:///app/src/chats/directory.ts:144:9)',
      '    at new Promise (<anonymous>)',
      '    at async Promise.all (index 0)',
      '    at run (file:///app/src/runtime/bridge.ts:40:20)',
    ].join('\n')
    expect(framesOf(error)).toEqual([
      'at load (file:///app/src/chats/directory.ts:144:9)',
      'at run (file:///app/src/runtime/bridge.ts:40:20)',
    ])
  })
})
