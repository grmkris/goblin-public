import { createRegistry } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { agentApps } from '../../src/agent-apps/engine.ts'
import { AppFiles } from '../../src/agent-apps/files.ts'
import { problemText } from '../../src/agent-apps/queue.ts'
import { runScript } from '../../src/agent-apps/script.ts'
import type { RuntimeEnv } from '../../src/env.ts'

const LIB = 'export const bump = (count: number, by: number): number => count + by\n'

const COUNTER_V1 = `import { defineApp, s } from '@goblin/app'
import { bump } from './lib'

export default defineApp({
  name: 'counter',
  title: 'Counter',
  description: 'Counts.',
  state: { schema: s.object({ count: s.number({ int: true }) }), initial: { count: 0 } },
  actions: {
    add: {
      description: 'Add to the count.',
      input: s.object({ by: s.number({ int: true, min: 1, max: 100 }) }),
      prepare: async (input, ctx) => {
        await ctx.files.write('/log.txt', \`+\${input.by} at \${ctx.state.count}\`)
        ctx.log('adding', input.by)
        return { seen: ctx.state.count }
      },
      run: (input: { by: number }, ctx) => ({ count: bump(ctx.state.count, input.by) }),
    },
    fail: {
      description: 'Always fails.',
      input: s.object({}),
      run: () => {
        throw new Error('nope')
      },
    },
  },
  views: { total: { description: 'The count.', input: s.object({}), select: (input, ctx) => ctx.state.count } },
})
`

const COUNTER_V2 = COUNTER_V1.replace(
  'state: { schema: s.object({ count: s.number({ int: true }) }), initial: { count: 0 } },',
  `state: {
    schema: s.object({ count: s.number({ int: true }), history: s.array(s.string()) }),
    initial: { count: 0, history: [] },
    migrate: (previous) => ({ count: previous.count, history: [] }),
  },`,
).replace(
  'run: (input: { by: number }, ctx) => ({ count: bump(ctx.state.count, input.by) }),',
  'run: (input: { by: number }, ctx) => ({ count: bump(ctx.state.count, input.by), history: [...ctx.state.history, ctx.id()] }),',
)

const outcome = async <A>(work: () => Promise<A>) => {
  try {
    return { ok: true as const, value: await work() }
  } catch (cause) {
    return { ok: false as const, error: problemText(cause) }
  }
}

/**
 * The agent apps engine on the real SQLite, Worker Loader and R2 (ADR 0021): build, call with receipts, refuse bad
 * input and a failing run, migrate on upgrade, keep a broken build from running, roll back, and restore in a fresh
 * engine. Plus a one-off script over the owner's files with no network.
 */
export async function appsEngineProbe(storage: DurableObjectStorage, env: RuntimeEnv, owner: string) {
  const apps = agentApps(storage, env, () => owner)
  apps.attach(createRegistry())
  apps.restore()
  const changes: string[] = []
  apps.onChange((app) => changes.push(app))
  const caller = { session: '1', callId: 'build-1' }
  const v1 = await apps.build({ name: 'counter', files: { 'app.ts': COUNTER_V1, 'lib.ts': LIB } }, caller)
  const call = (member: string, input: unknown, op: string) =>
    outcome(() => apps.dispatch.call({ app: 'counter', member, input, op }))
  const first = await call('add', { by: 2 }, 'op-1')
  const second = await call('add', { by: 3 }, 'op-2')
  const replay = await call('add', { by: 3 }, 'op-1')
  const total = await call('total', {}, 'view-1')
  const badInput = await call('add', { by: 0 }, 'op-3')
  const failing = await call('fail', {}, 'op-4')
  const afterFailing = apps.store.state('counter')?.revision
  const log = await new AppFiles(storage.sql, env.FILES, () => owner, 'counter').read('/log.txt')
  const v2 = await apps.build({ name: 'counter', files: { 'app.ts': COUNTER_V2 }, note: 'history' }, caller)
  const migrated = apps.store.state('counter')
  const broken = await apps.build(
    {
      name: 'counter',
      edits: [{ file: 'app.ts', find: 'history: [...ctx.state.history, ctx.id()] }', replace: 'history: [ }' }],
    },
    caller,
  )
  const stillRuns = await call('add', { by: 1 }, 'op-5')
  const fixed = await apps.build(
    {
      name: 'counter',
      edits: [{ file: 'app.ts', find: 'history: [ }', replace: 'history: [...ctx.state.history, ctx.id()] }' }],
    },
    caller,
  )
  const rolledBack = v1.status === 'active' ? await outcome(() => apps.rollback('counter', v1.release)) : undefined
  const afterRollback = apps.store.state('counter')
  const fresh = agentApps(storage, env, () => owner)
  fresh.attach(createRegistry())
  fresh.restore()
  const script = await runScript(
    apps.isolates,
    apps.ownerFiles,
    "await files.write('/agent/answer.txt', 'forty-two'); log('wrote', 1); return { answer: 6 * 7, text: await files.read('/agent/answer.txt') }",
  )
  const offline = await runScript(apps.isolates, apps.ownerFiles, "return (await fetch('https://example.com')).status")
  return {
    v1:
      v1.status === 'active' ? { status: v1.status, version: v1.version, tools: v1.tools, revision: v1.revision } : v1,
    first,
    second,
    replay,
    total,
    badInput: badInput.ok ? 'accepted' : badInput.error.split(' — ')[0],
    failing: failing.ok ? 'accepted' : failing.error.slice(0, 300),
    afterFailing,
    log,
    events: apps.store.events('counter', 50).map((event) => event.kind),
    v2: v2.status === 'active' ? { version: v2.version, migrated: v2.migrated } : v2,
    migrated: migrated?.state,
    broken:
      broken.status === 'failed'
        ? { status: broken.status, line: broken.problems[0]?.line, file: broken.problems[0]?.file }
        : broken.status,
    stillRuns: stillRuns.ok,
    fixed: fixed.status,
    rolledBack,
    afterRollback: afterRollback?.state,
    restored: fresh.extensions().map((extension) => extension.name),
    changes: changes.length > 0,
    script: { ok: script.ok, value: script.value, logs: script.logs },
    offline: { ok: offline.ok, refused: (offline.error ?? '').length > 0 },
  }
}

/**
 * The agent builds an app through Pi with the scripted model, and its tool is offered and works from the very next
 * request: the getter-backed default selection picks the installed extension up.
 */
export async function appsTurnProbe(harness: PiHarness, offered: () => readonly string[]) {
  const build = JSON.stringify({
    name: 'tally',
    files: { 'app.ts': COUNTER_V1.replace("name: 'counter'", "name: 'tally'"), 'lib.ts': LIB },
  })
  await harness.submit(`call app_build ${build}`, { session: '1', operationId: 'apps-build' })
  const built = await harness.wait('apps-build', { session: '1' })
  await harness.submit('call app_tally__add {"by":4}', { session: '1', operationId: 'apps-call' })
  const called = await harness.wait('apps-call', { session: '1' })
  return { built: built.text ?? '', called: called.text ?? '', offered: [...offered()] }
}
