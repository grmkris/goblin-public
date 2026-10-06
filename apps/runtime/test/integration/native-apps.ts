import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

const probe = (url: string, path: string) =>
  Effect.promise(async () => {
    const response = await fetch(`${url.replace(/\/+$/u, '')}${path}?name=${path.slice(1)}-${Date.now()}`)
    const text = await response.text()
    expect(response.status, text).toBe(200)
    const result: unknown = JSON.parse(text)
    return result
  })

/** Agent apps on the real Worker Loader, SQLite and R2 (ADR 0021). */
export function appsCase(url: string) {
  return Effect.gen(function* () {
    const engine = yield* probe(url, '/apps-engine')
    expect(engine).toMatchObject({
      v1: {
        status: 'active',
        version: 1,
        tools: ['app_counter__add', 'app_counter__fail', 'app_counter__total'],
        revision: 1,
      },
      first: { ok: true, value: { kind: 'action', revision: 2, state: { count: 2 } } },
      second: { ok: true, value: { kind: 'action', revision: 3, state: { count: 5 } } },
      replay: { ok: true, value: { kind: 'action', revision: 2 } },
      total: { ok: true, value: { kind: 'view', revision: 3, value: 5 } },
      badInput: 'InvalidInput',
      afterFailing: 3,
      log: '+3 at 2',
      events: ['build', 'log', 'call', 'log', 'call', 'error', 'build', 'failed', 'log', 'call', 'rollback'],
      v2: { version: 2, migrated: true },
      migrated: { count: 5, history: [] },
      broken: { status: 'failed', file: 'app.ts', line: 22 },
      stillRuns: true,
      fixed: 'unchanged',
      rolledBack: { ok: true, value: { version: 1, restored: 'snapshot' } },
      afterRollback: { count: 5 },
      restored: ['goblin.app.counter'],
      changes: true,
      script: { ok: true, value: { answer: 42, text: 'forty-two' }, logs: ['wrote 1'] },
      offline: { ok: false, refused: true },
    })
    // The app's own error comes back with its stack, pointing into its own module.
    expect(JSON.stringify(engine)).toMatch(/fail\.run failed: Error: nope\\n {4}at run \(app\.js:\d+/u)
    const powers = yield* probe(url, '/apps-powers')
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
    const turn = yield* probe(url, '/apps-turn')
    expect(turn).toMatchObject({
      built: expect.stringContaining('"status":"active","app":"tally"'),
      called: 'done: {"revision":2,"state":{"count":4}}',
    })
    // Built in one turn, offered from the next request: main selects app extensions through the settings getter.
    expect(turn).toHaveProperty(
      'offered',
      expect.arrayContaining([
        'app_build',
        'code_run',
        'app_tally__add',
        'app_tally__total',
        'mcp_suggest',
        'mcp_request_server',
      ]),
    )
  })
}
