import { describe, expect, it, vi } from '@effect/vitest'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import { LOG_KEYS, LoggerLive, logEvent, writeLine } from '../../src/observability/logger.ts'
import { withLines } from './lines.ts'

const SECRET = 'the owner wrote: please keep my diagnosis private'

describe('goblin logger', () => {
  it.effect('writes annotations only, never the message or the cause', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        Effect.logError(SECRET, Cause.fail(new Error(SECRET))).pipe(
          Effect.annotateLogs({ 'goblin.where': 'test.logger', ref: '7f3a9c12' }),
          Effect.provide(LoggerLive),
        ),
      )
      expect(lines).toEqual([
        { method: 'error', line: { level: 'error', 'goblin.where': 'test.logger', ref: '7f3a9c12' } },
      ])
      expect(JSON.stringify(lines)).not.toContain('diagnosis')
    }),
  )

  it.effect('drops annotation keys outside LOG_KEYS and values of the wrong shape, keeps run attributes', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        Effect.logWarning('ignored').pipe(
          Effect.annotateLogs({
            'goblin.where': 'test.logger',
            prompt: SECRET,
            'gen_ai.request.model': 'fixture-model',
            ref: SECRET,
            'error.type': 'Cannot read properties of undefined',
            frames: [SECRET],
            name: 'Kristjan Grm',
          }),
          Effect.provide(LoggerLive),
        ),
      )
      expect(LOG_KEYS).toContain('goblin.where')
      expect(LOG_KEYS).not.toContain('prompt')
      expect(lines).toEqual([
        {
          method: 'warn',
          line: { level: 'warn', 'goblin.where': 'test.logger', 'gen_ai.request.model': 'fixture-model' },
        },
      ])
    }),
  )

  it.effect('adds log spans with their duration', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        Effect.logInfo('ignored').pipe(Effect.withLogSpan('chats.send'), Effect.provide(LoggerLive)),
      )
      expect(lines).toEqual([{ method: 'log', line: { level: 'info', spans: { 'chats.send': 0 } } }])
    }),
  )

  it.effect('writes a named event with the current annotations, through the same filter', () =>
    Effect.gen(function* () {
      const { lines } = yield* withLines(
        logEvent('warn', 'http.failure', {
          route: '/api/conversations/:id',
          method: 'POST',
          status: 500,
          body: SECRET,
        }).pipe(Effect.annotateLogs({ request: 'r8c1d2e3' })),
      )
      expect(lines).toEqual([
        {
          method: 'warn',
          line: {
            level: 'warn',
            request: 'r8c1d2e3',
            route: '/api/conversations/:id',
            method: 'POST',
            status: 500,
            event: 'http.failure',
          },
        },
      ])
    }),
  )

  it('keeps the failure summary of a run line whose type is a log field', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      // A ledger line arrives already sanitized: `goblin.error` is the summary, and `error.type` a log field.
      writeLine('info', { event: 'run', 'error.type': 'provider_error', 'goblin.error': 'Model provider failed.' })
      writeLine('info', { event: 'run', 'error.type': 'UpstreamMcp:timeout', 'goblin.error': SECRET })
      writeLine('info', { event: 'run', 'error.type': 'payment_refused:insufficient_funds', 'goblin.error': SECRET })
      expect(log.mock.calls.map(([text]: unknown[]) => JSON.parse(String(text)))).toEqual([
        { level: 'info', 'goblin.error': 'Model provider failed.', event: 'run', 'error.type': 'provider_error' },
        {
          level: 'info',
          'goblin.error': 'Remote MCP request failed (timeout).',
          event: 'run',
          'error.type': 'UpstreamMcp:timeout',
        },
        {
          level: 'info',
          'goblin.error': 'Payment from the Goblin Wallet refused (insufficient_funds).',
          event: 'run',
          'error.type': 'payment_refused:insufficient_funds',
        },
      ])
    } finally {
      log.mockRestore()
    }
  })

  it('writes a line from synchronous code through the global console', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      writeLine('info', { event: 'wake', kind: 'routine', note: SECRET })
      expect(log.mock.calls).toEqual([[JSON.stringify({ level: 'info', event: 'wake', kind: 'routine' })]])
    } finally {
      log.mockRestore()
    }
  })
})
