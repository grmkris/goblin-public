import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { type NativeCase, probeOf } from './native-case.ts'

/** Agent apps on the real Worker Loader, SQLite and R2 (ADR 0021). */
async function appsChecks(base: string): Promise<void> {
  const engine = await probeOf(base, 'apps-engine', Schema.Unknown)
  expect(engine).toMatchObject({
    v1: {
      status: 'active',
      version: 1,
      members: ['add', 'fail', 'total', 'label'],
      revision: 1,
    },
    first: { ok: true, value: { kind: 'action', revision: 2, state: { count: 2 } } },
    second: { ok: true, value: { kind: 'action', revision: 3, state: { count: 5 } } },
    replay: { ok: true, value: { kind: 'action', revision: 2 } },
    total: { ok: true, value: { kind: 'view', revision: 3, value: 5 } },
    label: expect.stringContaining('view label returned a value that does not fit its output'),
    listed: expect.stringContaining('views total() → integer, label() → string'),
    badInput: 'InvalidInput',
    afterFailing: 3,
    log: '+3 at 2',
    // The label view's misfit, then the failing action's error.
    events: ['build', 'log', 'call', 'log', 'call', 'error', 'error', 'build', 'failed', 'log', 'call', 'rollback'],
    v2: { version: 2, migrated: true },
    migrated: { count: 5, history: [] },
    broken: { status: 'failed', file: 'app.ts', line: 22 },
    stillRuns: true,
    fixed: 'unchanged',
    rolledBack: { ok: true, value: { version: 1, restored: 'snapshot' } },
    afterRollback: { count: 5 },
    restored: ['goblin.app-call'],
    changes: true,
    script: { ok: true, value: { answer: 42, text: 'forty-two' }, logs: ['wrote 1'] },
    offline: { ok: false, refused: true },
  })
  // The app's own error comes back with its stack, pointing into its own module.
  expect(JSON.stringify(engine)).toMatch(/fail\.run failed: Error: nope\\n {4}at run \(app\.js:\d+/u)
  const powers = await probeOf(base, 'apps-powers', Schema.Unknown)
  expect(powers).toMatchObject({
    approval: {
      app: 'weather',
      title: 'Weather',
      powers: [
        { kind: 'egress', target: 'api.weather.test' },
        { kind: 'egress', target: 'moved.weather.test' },
        { kind: 'egress', target: 'x.goblin.test' },
        { kind: 'tool', target: 'notes/list' },
        { kind: 'llm', target: '*' },
        { kind: 'notify', target: '*' },
      ],
    },
    refused: expect.stringContaining('api.weather.test is not approved'),
    fetched: { kind: 'action', revision: 2, state: { temp: 21 } },
    unlisted: expect.stringContaining('evil.test is not approved'),
    offList: expect.stringContaining('evil.test is not approved'),
    onList: { kind: 'action', state: { temp: 21 } },
    own: expect.stringContaining('does not reach goblin itself'),
    plain: expect.stringContaining('only https://'),
    revoked: expect.stringContaining('api.weather.test is not approved'),
    askedBefore: expect.stringContaining('llm * is not approved'),
    asked: 'ran',
    seen: [
      ['complete', 'Say hi', 1024],
      ['notify', expect.stringMatching(/^app-weather-p-10-1$/u), 'It is warm'],
      ['tool', 'notes', 'list', { limit: 1 }],
    ],
    readerApproval: { app: 'reader', powers: [{ kind: 'app', target: 'weather' }] },
    read: { kind: 'action', state: { seen: 21 } },
    powers: expect.arrayContaining([
      { kind: 'egress', target: 'api.weather.test', status: 'revoked' },
      { kind: 'llm', target: '*', status: 'approved' },
    ]),
    // Every fetch an app attempts counts toward its day, refused ones too.
    usage: { egress: 8, notify: 1 },
  })
  const MINUTE = 60_000
  const jobs = await probeOf(base, 'apps-jobs', Schema.Unknown)
  expect(jobs).toMatchObject({
    wrong: expect.arrayContaining([
      expect.stringContaining('every is one of 15m, 30m'),
      expect.stringContaining('no action nope'),
    ]),
    built: 'active',
    first: [
      { action: 'tick', every: '15m', at: null, inMs: 8 * MINUTE, time: expect.stringMatching(/:15$/u) },
      { action: 'flaky', every: '1d', at: '06:30', time: '06:30' },
    ],
    armedFirst: 2,
    afterTick: { ticks: 1, job: { status: 'ok', failures: 0 } },
    afterStale: 1,
    // Two hours late: one catch-up run, then the next slot.
    caughtUp: { ticks: 2, inMs: 15 * MINUTE - 2000 },
    waiting: { ticks: 2, job: { status: 'waiting', error: 'waiting for the owner (test)' } },
    waits: [15, 30, 60, 120, 240, 360, 360, 360, 360].map((minutes) => minutes * MINUTE),
    paused: { paused: 'failures', failures: 10, status: 'failed', error: expect.stringContaining('flaky failed') },
    armedPaused: 1,
    resumed: { paused: null, failures: 0 },
    armedResumed: 2,
    viaAgent: { changed: true, status: expect.stringMatching(/^(?:ok|waiting)$/u) },
    afterDrop: ['flaky'],
    armedAfterDrop: 1,
    summary: expect.stringContaining('Schedules: flaky every 1d at 06:30 UTC (last run'),
    manage: {
      paused: { paused: 'owner' },
      armedPaused: 0,
      resumed: { paused: null },
      ran: { status: 'ok', error: null },
      home: '1',
      badHome: 'NotFound',
      listed: [expect.objectContaining({ name: 'ticker', app: null, home: '1' })],
      refused: 'InvalidInput',
      objects: { before: expect.any(Number), after: 0 },
      removed: { deleted: 'ticker' },
      gone: { app: true, jobs: 0, armed: 0, files: { count: 0, bytes: 0 } },
    },
  })
  expect(jobs).toHaveProperty(
    'manage.objects.before',
    expect.toSatisfy((count: number) => count > 0),
  )
  const turn = await probeOf(base, 'apps-turn', Schema.Unknown)
  expect(turn).toMatchObject({
    built: expect.stringContaining('"status":"active","app":"tally"'),
    called: 'done: {"revision":2,"state":{"count":4}}',
    // The build changed the trailing context block, not the system prompt or the tools the provider caches.
    samePrompt: true,
    sameTools: true,
    listedBefore: false,
    listedAfter: true,
  })
  // Built in one turn, called from the next through the one app_call tool (ADR 0027).
  expect(turn).toHaveProperty(
    'offered',
    expect.arrayContaining(['app_build', 'code_run', 'app_call', 'mcp_suggest', 'mcp_request_server']),
  )
}

export const cases: readonly NativeCase[] = [
  {
    title: 'agent apps build, call with receipts, migrate, refuse a broken build, roll back and restore',
    run: appsChecks,
  },
]
