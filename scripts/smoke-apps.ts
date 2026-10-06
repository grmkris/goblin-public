// The dev smoke's agent app check (ADR 0021), apart from smoke-dev.ts, which runs on import.
const SMOKE_APP = 'smoke-counter'
const SMOKE_APP_SOURCE = `import { defineApp, s } from '@goblin/app'

export default defineApp({
  name: '${SMOKE_APP}',
  title: 'Smoke counter',
  description: 'Counts for the dev smoke test.',
  state: { schema: s.object({ count: s.number({ int: true }) }), initial: { count: 0 } },
  schedules: [{ action: 'add', every: '1d', at: '03:00', input: { by: 1 } }],
  actions: {
    add: {
      description: 'Add to the count.',
      input: s.object({ by: s.number({ int: true }) }),
      run: (input, ctx) => ({ count: ctx.state.count + input.by }),
    },
  },
})
`

/** The owner's requests to the deployed stage. */
type Owner = { readonly send: (path: string, init?: RequestInit) => Promise<Response> }

/** The smoke's own thread steps: send a message, wait until the thread is idle, close it. */
type ThreadSteps<D extends Owner> = {
  readonly submit: (dev: D, thread: string, input: string, step: string) => Promise<void>
  readonly idle: (dev: D, thread: string) => Promise<unknown>
  readonly close: (dev: D, thread: string) => Promise<void>
}

const OWNER_WRITE = { 'content-type': 'application/json', 'x-goblin-csrf': '1' }

/** The smoke app's revision as the owner's Apps routes list it, or undefined when there is none. */
async function smokeRevision(dev: Owner): Promise<number | undefined> {
  const response = await dev.send('/api/agent-apps')
  if (!response.ok) throw new Error('apps_list_failed')
  const apps: unknown = await response.json()
  const app = Array.isArray(apps) ? apps.find((each) => each?.name === SMOKE_APP) : undefined
  return typeof app?.revision === 'number' ? app.revision : undefined
}

const deleteSmokeApp = async (dev: Owner): Promise<boolean> =>
  (
    await dev.send(`/api/agent-apps/${SMOKE_APP}`, {
      method: 'DELETE',
      headers: OWNER_WRITE,
      body: JSON.stringify({ confirm: SMOKE_APP }),
    })
  ).ok

/** The revision after the owner runs the smoke app's schedule now. */
async function runNow(dev: Owner): Promise<unknown> {
  const response = await dev.send(`/api/agent-apps/${SMOKE_APP}`, {
    method: 'POST',
    headers: OWNER_WRITE,
    body: JSON.stringify({ kind: 'run', action: 'add' }),
  })
  if (!response.ok) throw new Error('app_run_failed')
  const detail: unknown = await response.json()
  return typeof detail === 'object' && detail !== null && 'revision' in detail ? detail.revision : undefined
}

/**
 * Agent apps (ADR 0021): in a throwaway thread the agent builds a counter from exact code, the owner runs its
 * schedule now and its revision moves, then the owner deletes it and the thread closes.
 */
export async function appChecks<D extends Owner>(dev: D, steps: ThreadSteps<D>): Promise<{ readonly app: 'ok' }> {
  const created = await dev.send('/api/conversations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const body: unknown = await created.json()
  const thread = typeof body === 'object' && body !== null && 'id' in body ? String(body.id) : ''
  if (!created.ok || thread === '') throw new Error('app_thread_failed')
  try {
    const files = JSON.stringify({ 'app.ts': SMOKE_APP_SOURCE })
    const ask = `Call app_build once with name "${SMOKE_APP}" and files ${files}, exactly as given, then reply "built".`
    await steps.submit(dev, thread, ask, 'app_build')
    await steps.idle(dev, thread)
    const built = await smokeRevision(dev)
    if (built === undefined) throw new Error('app_not_built')
    if ((await runNow(dev)) !== built + 1) throw new Error('app_run_did_not_move_revision')
    if (!(await deleteSmokeApp(dev))) throw new Error('app_delete_failed')
    if ((await smokeRevision(dev)) !== undefined) throw new Error('app_still_listed')
    return { app: 'ok' }
  } finally {
    if ((await smokeRevision(dev).catch(() => undefined)) !== undefined) await deleteSmokeApp(dev)
    await steps.close(dev, thread)
  }
}
