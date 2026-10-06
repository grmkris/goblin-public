import { expect } from 'vitest'
import { Schema } from 'effect'
import { AppCallResult, AppLaunch, AppSnapshot, ConversationView, WorkspaceSnapshot } from '@goblin/contracts'
import { type Person, call, person, waitFor } from './owner-requests.ts'

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

/** An owner request; `csrf: false` leaves out the header the web sends on every write. */
const send = (base: string, who: Person, path: string, init: { method: string; body?: unknown; csrf?: boolean }) =>
  fetch(`${base}${path}`, {
    method: init.method,
    headers: {
      cookie: who.cookie,
      origin: 'https://goblin.test',
      'content-type': 'application/json',
      ...(init.csrf === false ? {} : { 'x-goblin-csrf': '1' }),
      'cf-connecting-ip': who.ip,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

async function snapshot(base: string, owner: Person): Promise<WorkspaceSnapshot> {
  const response = await send(base, owner, '/api/workspace/events', { method: 'GET' })
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
    buffer += decoder.decode(read.value, { stream: true })
    const frame = buffer.split('\n\n').find((part) => part.includes('event: snapshot'))
    const data = frame === undefined ? undefined : /^data: (.*)$/mu.exec(frame)?.[1]
    if (data !== undefined) {
      await reader?.cancel()
      return Schema.decodeUnknownSync(WorkspaceSnapshot)(JSON.parse(data))
    }
  }
  throw new Error('no workspace snapshot')
}

const say = (base: string, owner: Person, thread: string, tool: string, input: unknown) =>
  call(base, owner, `/api/conversations/${thread}/messages`, {
    input: `call ${tool} ${JSON.stringify(input)}`,
    operationId: crypto.randomUUID(),
  })

/**
 * An agent app with a view (ADR 0021): built in a conversation, it shows under that conversation in the workspace, its
 * launch carries the view's module, stylesheet and frame bundles with the state, and the view calls its actions over
 * the owner's routes with an operation id, reads its state and reports its failures. A view that imports what the
 * frame does not have fails to build.
 */
export async function agentAppViewCase(base: string): Promise<void> {
  const owner = await person(base)
  await call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyTokens: 1000 })
  const thread = Schema.decodeUnknownSync(ConversationView)(
    await (await call(base, owner, '/api/conversations', {})).json(),
  )
  const conversation = `/api/conversations/${thread.id}/snapshot`
  await say(base, owner, thread.id, 'app_build', { name: 'tapper', files: { 'app.ts': APP, 'view.tsx': VIEW } })
  await waitFor(base, owner, conversation, '\\"ui\\":true')
  const app = (await snapshot(base, owner)).apps.find((each) => each.source.kind === 'agent')
  expect(app).toMatchObject({
    conversation: thread.id,
    title: 'Tapper',
    source: { kind: 'agent', name: 'tapper', version: 1, revision: 1 },
  })
  if (app === undefined) throw new Error('no agent app shown')

  const launch = Schema.decodeUnknownSync(AppLaunch)(
    await (await send(base, owner, `/api/apps/${app.id}/launch`, { method: 'GET' })).json(),
  )
  if (launch.kind !== 'agent') throw new Error('not an agent app launch')
  expect(launch).toMatchObject({ name: 'tapper', revision: 1, state: { count: 0 }, ui: { libs: ['charts'] } })
  expect(launch.ui.module).toMatch(/require\(['"]@goblin\/kit\/chart['"]\)/u)
  expect(launch.ui.module).not.toContain('./app')
  expect(launch.ui.css).toContain('grid-cols-\\[2fr_1fr\\]')

  const act = async (name: string, args: Record<string, unknown>, op: string = crypto.randomUUID()) => {
    const response = await send(base, owner, `/api/apps/${app.id}/call`, {
      method: 'POST',
      body: { name, arguments: args, op },
    })
    return { status: response.status, body: await response.text() }
  }
  const op = crypto.randomUUID()
  const tapped = await act('tap', { by: 2 }, op)
  expect(Schema.decodeUnknownSync(AppCallResult)(JSON.parse(tapped.body))).toMatchObject({
    ok: true,
    revision: 2,
    release: launch.release,
    state: { count: 2 },
  })
  expect(JSON.parse((await act('tap', { by: 2 }, op)).body)).toMatchObject({ ok: true, revision: 2 })
  expect(JSON.parse((await act('broken', {})).body)).toMatchObject({
    ok: false,
    error: expect.stringContaining('broken on purpose'),
  })
  expect((await act('missing', {})).status).toBe(400)
  expect((await act('tap', { by: 9 })).status).toBe(400)
  const refused = await send(base, owner, `/api/apps/${app.id}/call`, {
    method: 'POST',
    body: { name: 'tap', arguments: {}, op },
    csrf: false,
  })
  expect(refused.status).toBe(403)

  const state = Schema.decodeUnknownSync(AppSnapshot)(
    await (await send(base, owner, `/api/apps/${app.id}/state`, { method: 'GET' })).json(),
  )
  expect(state).toMatchObject({ revision: 2, state: { count: 2 } })
  const report = (message: string) =>
    send(base, owner, `/api/apps/${app.id}/diagnostics`, { method: 'POST', body: { message } })
  expect(await (await report('TypeError: count is undefined')).json()).toEqual({ kept: true })
  expect(await (await report('TypeError: again')).json()).toEqual({ kept: false })
  expect((await snapshot(base, owner)).apps.find((each) => each.id === app.id)?.source).toMatchObject({ revision: 2 })

  await say(base, owner, thread.id, 'app_build', {
    name: 'tapper',
    edits: [
      { file: 'view.tsx', find: "import { Button } from '@goblin/ui'", replace: "import fs from 'node:fs'" },
      { file: 'view.tsx', find: '<Button onClick', replace: '<Button title={fs.readFileSync("/x")} onClick' },
    ],
  })
  await waitFor(base, owner, conversation, 'Cannot import \\\\\\"node:fs\\\\\\" in the view')
}
