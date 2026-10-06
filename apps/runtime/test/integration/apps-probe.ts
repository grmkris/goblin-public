import { createRegistry } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { agentApps } from '../../src/agent-apps/engine.ts'
import type { Send } from '../../src/agent-apps/egress.ts'
import { AppFiles } from '../../src/agent-apps/files.ts'
import { problemText } from '../../src/agent-apps/queue.ts'
import { runScript } from '../../src/agent-apps/script.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { memorySchedules } from './apps-jobs-probe.ts'
import type { SeenRequest } from './model.ts'

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
  views: {
    total: { description: 'The count.', input: s.object({}), output: s.number({ int: true }), select: (input, ctx) => ctx.state.count },
    label: { description: 'Promises a label, returns the count.', input: s.object({}), output: s.string(), select: (input, ctx) => ctx.state.count },
  },
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

/** A refused call's error, cut to a line or two; `accepted` when it was not refused. */
const refusal = (result: { readonly ok: true } | { readonly ok: false; readonly error: string }) =>
  result.ok ? 'accepted' : result.error.slice(0, 300)

/**
 * The agent apps engine on the real SQLite, Worker Loader and R2 (ADR 0021): build, call with receipts, refuse bad
 * input and a failing run, migrate on upgrade, keep a broken build from running, roll back, and restore in a fresh
 * engine. Plus a one-off script over the owner's files with no network.
 */
export async function appsEngineProbe(storage: DurableObjectStorage, env: RuntimeEnv, owner: string) {
  const apps = agentApps(storage, env, () => owner, { schedules: memorySchedules() })
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
  const label = await call('label', {}, 'view-2')
  const listed = apps.summary()
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
  const fresh = agentApps(storage, env, () => owner, { schedules: memorySchedules() })
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
      v1.status === 'active'
        ? { status: v1.status, version: v1.version, members: v1.members, revision: v1.revision }
        : v1,
    first,
    second,
    replay,
    total,
    label: refusal(label),
    listed,
    badInput: badInput.ok ? 'accepted' : badInput.error.split(' — ')[0],
    failing: refusal(failing),
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

/** A system prompt without the memory's guide, which joins it once, when main's first memory view lands. */
const withoutMemory = (prompt: string) => prompt.replace(/\n*<memory>[\s\S]*?<\/memory>/u, '')
/** The tools without the memory's `zoom`, which joins them at the same moment. */
const withoutZoom = (tools: readonly string[] | undefined) => (tools ?? []).filter((tool) => tool !== 'zoom')

/**
 * The agent builds an app through Pi with the scripted model, and its tool is offered and works from the very next
 * request: the getter-backed default selection picks the installed extension up. The build changes the trailing
 * context block, not the system prompt, so the prompt the provider caches stays the same.
 */
export async function appsTurnProbe(harness: PiHarness, seen: () => readonly SeenRequest[]) {
  const build = JSON.stringify({
    name: 'tally',
    files: { 'app.ts': COUNTER_V1.replace("name: 'counter'", "name: 'tally'"), 'lib.ts': LIB },
  })
  const main = () => seen().filter((request) => request.systemPrompt.includes('You can build apps'))
  const before = main().length
  await harness.submit(`call app_build ${build}`, { session: '1', operationId: 'apps-build' })
  const built = await harness.wait('apps-build', { session: '1' })
  await harness.submit('call app_call {"app":"tally","member":"add","input":{"by":4}}', {
    session: '1',
    operationId: 'apps-call',
  })
  const called = await harness.wait('apps-call', { session: '1' })
  const [first] = main().slice(before)
  const last = main().at(-1)
  return {
    built: built.text ?? '',
    called: called.text ?? '',
    offered: [...(last?.tools ?? [])],
    samePrompt: first !== undefined && withoutMemory(first.systemPrompt) === withoutMemory(last?.systemPrompt ?? ''),
    sameTools:
      first !== undefined && JSON.stringify(withoutZoom(first.tools)) === JSON.stringify(withoutZoom(last?.tools)),
    listedBefore: first?.context?.includes('- tally (') ?? false,
    listedAfter: last?.context?.includes('- tally (') ?? false,
  }
}

const WEATHER = `import { defineApp, s } from '@goblin/app'

export default defineApp({
  name: 'weather',
  title: 'Weather',
  description: 'The temperature now.',
  egress: ['api.weather.test', 'moved.weather.test', 'x.goblin.test'],
  uses: { llm: true, notify: true, tools: ['notes/list'] },
  state: { schema: s.object({ temp: s.nullable(s.number()) }), initial: { temp: null } },
  actions: {
    refresh: {
      description: 'Fetch the temperature.',
      input: s.object({ from: s.string() }),
      prepare: async (input, ctx) => (await (await ctx.fetch(input.from)).json()).temp,
      run: (input, ctx, temp) => ({ temp }),
    },
    ask: {
      description: 'Ask the model, tell the owner and read a note list.',
      input: s.object({}),
      prepare: async (input, ctx) => {
        const answer = await ctx.llm.complete('Say hi', { maxTokens: 5000 })
        await ctx.notify('It is warm')
        const notes = await ctx.tools.call('notes/list', { limit: 1 })
        return { answer, notes }
      },
      run: (input, ctx) => ctx.state,
    },
  },
  views: { now: { description: 'The temperature.', input: s.object({}), select: (input, ctx) => ctx.state.temp } },
})
`

const READER = `import { defineApp, s } from '@goblin/app'

export default defineApp({
  name: 'reader',
  title: 'Reader',
  description: 'Reads the weather app.',
  uses: { apps: ['weather'] },
  state: { schema: s.object({ seen: s.nullable(s.number()) }), initial: { seen: null } },
  actions: {
    read: {
      description: 'Read the weather app.',
      input: s.object({}),
      prepare: async (input, ctx) => ctx.apps.view('weather', 'now'),
      run: (input, ctx, seen) => ({ seen }),
    },
  },
  views: {},
})
`

/** The internet as the powers probe sees it: one API, one redirect off the approved list, one redirect onto it. */
const internet: Send = async (url) => {
  if (url.hostname === 'api.weather.test') return Response.json({ temp: 21 })
  if (url.pathname === '/away') return new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } })
  if (url.pathname === '/home')
    return new Response(null, { status: 301, headers: { location: 'https://api.weather.test/now' } })
  return new Response('not here', { status: 404 })
}

type Outcome = Awaited<ReturnType<typeof outcome>>
/** A call that should be refused, as its reason; one that ran, as `ran`. */
const said = (result: Outcome) => (result.ok ? 'ran' : result.error.slice(0, 200))
/** A call that should run, as its value; one refused, as its reason. */
const valueOf = (result: Outcome) => (result.ok ? result.value : result.error)
/** What an active build asks the owner to approve. */
const approvalOf = (built: Awaited<ReturnType<ReturnType<typeof agentApps>['build']>>) =>
  built.status === 'active' ? built.approval : built

/**
 * Agent app powers (ADR 0021): a build lists what the owner has not approved; nothing runs before they approve; an
 * approved host is fetched while unapproved hosts, redirects off the list and goblin's own domain are refused; a
 * revocation takes effect at once; one app reads another it may; the model, Telegram and MCP tools go through the
 * agent's services within the app's caps.
 */
export async function appsPowersProbe(storage: DurableObjectStorage, env: RuntimeEnv, owner: string) {
  const apps = agentApps(storage, env, () => owner, { schedules: memorySchedules(), fetch: internet })
  apps.attach(createRegistry())
  apps.restore()
  const seen: unknown[] = []
  apps.connect({
    tool: async (serverId, name, args) => {
      seen.push(['tool', serverId, name, args])
      return { content: [{ type: 'text', text: 'one note' }] }
    },
    complete: async (system, prompt, maxTokens) => {
      seen.push(['complete', prompt, maxTokens])
      return 'hi'
    },
    notify: async (op, text) => {
      seen.push(['notify', op, text])
    },
    blocked: async () => undefined,
  })
  const caller = { session: '1', callId: 'powers-1' }
  const built = await apps.build({ name: 'weather', files: { 'app.ts': WEATHER } }, caller)
  const call = (app: string, member: string, input: unknown, op: string) =>
    outcome(() => apps.dispatch.call({ app, member, input, op }))
  const refused = await call('weather', 'refresh', { from: 'https://api.weather.test/now' }, 'p-1')
  for (const target of ['api.weather.test', 'moved.weather.test', 'x.goblin.test'])
    apps.answer('weather', { kind: 'egress', target }, true)
  const fetched = await call('weather', 'refresh', { from: 'https://api.weather.test/now' }, 'p-2')
  const unlisted = await call('weather', 'refresh', { from: 'https://evil.test/now' }, 'p-3')
  const offList = await call('weather', 'refresh', { from: 'https://moved.weather.test/away' }, 'p-4')
  const onList = await call('weather', 'refresh', { from: 'https://moved.weather.test/home' }, 'p-5')
  const own = await call('weather', 'refresh', { from: 'https://x.goblin.test/now' }, 'p-6')
  const plain = await call('weather', 'refresh', { from: 'http://api.weather.test/now' }, 'p-7')
  apps.answer('weather', { kind: 'egress', target: 'api.weather.test' }, false)
  const revoked = await call('weather', 'refresh', { from: 'https://api.weather.test/now' }, 'p-8')
  const askedBefore = await call('weather', 'ask', {}, 'p-9')
  for (const kind of ['llm', 'notify'] as const) apps.answer('weather', { kind, target: '*' }, true)
  apps.answer('weather', { kind: 'tool', target: 'notes/list' }, true)
  const asked = await call('weather', 'ask', {}, 'p-10')
  const reader = await apps.build({ name: 'reader', files: { 'app.ts': READER } }, caller)
  apps.answer('reader', { kind: 'app', target: 'weather' }, true)
  const read = await call('reader', 'read', {}, 'p-11')
  return {
    approval: approvalOf(built),
    refused: said(refused),
    fetched: valueOf(fetched),
    unlisted: said(unlisted),
    offList: said(offList),
    onList: valueOf(onList),
    own: said(own),
    plain: said(plain),
    revoked: said(revoked),
    askedBefore: said(askedBefore),
    asked: said(asked),
    seen,
    readerApproval: approvalOf(reader),
    read: valueOf(read),
    powers: apps.powers('weather'),
    usage: apps.store.usage('weather', Date.now()),
  }
}
