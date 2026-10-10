import { expect } from 'vitest'
import { type AgentFetch, callOwner } from '../owner-client.ts'
import { call, grantPlan, person, showing, signedIn, snapshotText, workspaceOf } from './owner-requests.ts'
import { answerOf } from './probe-reads.ts'

const APP = `import { defineApp, s } from '@goblin/app'

export type State = { count: number }

export default defineApp({
  name: 'tapper',
  title: 'Tapper',
  description: 'Counts taps.',
  state: { schema: s.object({ count: s.number({ int: true }) }), initial: { count: 0 } },
  actions: {
    tap: {
      description: 'Tap.',
      input: s.object({ by: s.number({ int: true, min: 1, max: 5 }) }),
      run: (input, ctx) => ({ count: ctx.state.count + input.by }),
    },
    broken: {
      description: 'Fails.',
      input: s.object({}),
      agent: false,
      run: () => {
        throw new Error('broken on purpose')
      },
    },
  },
  views: {},
})
`

const VIEW = `import { useActions, useAppState } from '@goblin/app'
import { Button } from '@goblin/ui'
import { Chart } from '@goblin/kit/chart'
import type { State } from './app'

export default function View() {
  const [state] = useAppState<State>()
  const { act } = useActions()
  return (
    <div className="grid grid-cols-[2fr_1fr] p-4">
      <Button onClick={() => act('tap', { by: 1 })}>{state.count}</Button>
      <Chart spec={{ type: 'bar', x: 'k', series: [{ key: 'v' }], data: [{ k: 'taps', v: state.count }] }} />
    </div>
  )
}
`

const say = (me: AgentFetch, thread: string, tool: string, input: unknown) =>
  callOwner(me, (api) =>
    api.conversations.submit({
      params: { id: thread },
      payload: { input: `call ${tool} ${JSON.stringify(input)}`, operationId: crypto.randomUUID() },
    }),
  )

/**
 * An agent app with a view (ADR 0021): built in a conversation, it shows under that conversation in the workspace, its
 * launch carries the view's module, stylesheet and frame bundles with the state, and the view calls its actions over
 * the owner's routes with an operation id, reads its state and reports its failures. A view that imports what the
 * frame does not have, or that throws when rendered with the app's state, fails to build and changes nothing.
 */
export async function agentAppViewCase(base: string): Promise<void> {
  const owner = await person(base)
  await grantPlan(base, owner)
  const me = signedIn(base, owner)
  const thread = await callOwner(me, (api) => api.conversations.create({ payload: {} }))
  const apps = async () => (await workspaceOf(base, owner)).apps
  await say(me, thread.id, 'app_build', { name: 'tapper', files: { 'app.ts': APP, 'view.tsx': VIEW } })
  await showing(me, thread.id, '\\"ui\\":true')
  const app = (await apps()).find((each) => each.source.kind === 'agent')
  expect(app).toMatchObject({
    conversation: thread.id,
    title: 'Tapper',
    source: { kind: 'agent', name: 'tapper', version: 1, revision: 1 },
  })
  if (app === undefined) throw new Error('no agent app shown')
  const params = { id: app.id }

  const launch = await callOwner(me, (api) => api.apps.launch({ params }))
  if (launch.kind !== 'agent') throw new Error('not an agent app launch')
  expect(launch).toMatchObject({ name: 'tapper', revision: 1, state: { count: 0 }, ui: { libs: ['charts'] } })
  expect(launch.ui.module).toMatch(/require\(['"]@goblin\/kit\/chart['"]\)/u)
  expect(launch.ui.module).not.toContain('./app')
  expect(launch.ui.css).toContain('grid-cols-\\[2fr_1fr\\]')

  const act = (name: string, args: Record<string, unknown>, op: string = crypto.randomUUID()) =>
    callOwner(me, (api) => api.apps.call({ params, payload: { name, arguments: args, op } }))
  const refusedAct = (name: string, args: Record<string, unknown>) =>
    answerOf(me, (api) => api.apps.call({ params, payload: { name, arguments: args, op: crypto.randomUUID() } }))
  const op = crypto.randomUUID()
  expect(await act('tap', { by: 2 }, op)).toMatchObject({
    ok: true,
    revision: 2,
    release: launch.release,
    state: { count: 2 },
  })
  expect(await act('tap', { by: 2 }, op)).toMatchObject({ ok: true, revision: 2 })
  expect(await act('broken', {})).toMatchObject({
    ok: false,
    error: expect.stringContaining('broken on purpose'),
  })
  expect(await refusedAct('missing', {})).toBe('InvalidInput')
  expect(await refusedAct('tap', { by: 9 })).toBe('InvalidInput')
  // A write without the CSRF header is refused at the edge.
  const refused = await call(
    base,
    owner,
    `/api/apps/${app.id}/call`,
    { name: 'tap', arguments: {}, op },
    {
      'x-goblin-csrf': '',
    },
  )
  expect(refused.status).toBe(403)

  const state = () => callOwner(me, (api) => api.apps.state({ params }))
  expect(await state()).toMatchObject({ revision: 2, state: { count: 2 } })
  const report = (message: string) => callOwner(me, (api) => api.apps.diagnostics({ params, payload: { message } }))
  expect(await report('TypeError: count is undefined')).toEqual({ kept: true })
  expect(await report('TypeError: again')).toEqual({ kept: false })
  expect((await apps()).find((each) => each.id === app.id)?.source).toMatchObject({ revision: 2 })

  // The view renders once at build time with the state it starts with. One that throws fails its build with its line
  // of view.tsx, and the working release and its state stay as they were.
  expect(await snapshotText(me, thread.id)).not.toContain('viewWarning')
  await say(me, thread.id, 'app_build', {
    name: 'tapper',
    edits: [
      {
        file: 'view.tsx',
        find: '>{state.count}<',
        replace: '>{(state as unknown as { items: string[] }).items.length}<',
      },
    ],
  })
  await showing(me, thread.id, "It throws when rendered with the app's current state")
  expect(await showing(me, thread.id, '\\"line\\":11')).toContain('\\"status\\":\\"failed\\"')
  const kept = (await apps()).find((each) => each.id === app.id)?.source
  expect(kept).toMatchObject({ version: 1, revision: 2, release: launch.release })
  expect(await state()).toMatchObject({ revision: 2, release: launch.release, state: { count: 2 } })

  // Edits apply to the failed candidate, so the fix goes with them. Charts, maps, diagrams and icons pass the check; a
  // view that reads a browser global while rendering is not checkable there, so it activates with a warning.
  await say(me, thread.id, 'app_build', {
    name: 'tapper',
    edits: [
      {
        file: 'view.tsx',
        find: '>{(state as unknown as { items: string[] }).items.length}<',
        replace: '>{state.count}<',
      },
      {
        file: 'view.tsx',
        find: "import type { State } from './app'",
        replace: `import { MapView } from '@goblin/kit/map'
import { Diagram } from '@goblin/kit/diagram'
import { Check } from 'lucide-react'
import type { State } from './app'`,
      },
      {
        file: 'view.tsx',
        find: '    </div>',
        replace: `      <MapView spec={{ markers: [{ lat: 59.44, lng: 24.75, label: \`\${state.count} taps\` }] }} />
      <Diagram source={'graph TD\\n  A --> B'} fallback={<pre>A to B</pre>} />
      <Check className="size-4" />
    </div>`,
      },
    ],
  })
  await showing(me, thread.id, '\\"version\\":2')
  expect(await snapshotText(me, thread.id)).not.toContain('viewWarning')
  await say(me, thread.id, 'app_build', {
    name: 'tapper',
    edits: [
      { file: 'view.tsx', find: '>{state.count}<', replace: '>{state.count + (window.innerWidth > 600 ? 1 : 0)}<' },
    ],
  })
  await showing(me, thread.id, 'it reads window while rendering')
  expect((await apps()).find((each) => each.id === app.id)?.source).toMatchObject({ version: 3 })

  await say(me, thread.id, 'app_build', {
    name: 'tapper',
    edits: [
      { file: 'view.tsx', find: "import { Button } from '@goblin/ui'", replace: "import fs from 'node:fs'" },
      { file: 'view.tsx', find: '<Button onClick', replace: '<Button title={fs.readFileSync("/x")} onClick' },
    ],
  })
  await showing(me, thread.id, 'Cannot import \\\\\\"node:fs\\\\\\" in the view')
}
