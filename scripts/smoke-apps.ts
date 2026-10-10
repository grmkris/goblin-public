// The dev smoke's agent app check (ADR 0021), apart from smoke-dev.ts, which runs on import.
import type { DevClient } from './smoke-client.ts'

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

/** The smoke's own thread steps: send a message, wait until the thread is idle, close it. */
type ThreadSteps = {
  readonly submit: (dev: DevClient, thread: string, input: string, step: string) => Promise<void>
  readonly idle: (dev: DevClient, thread: string) => Promise<unknown>
  readonly close: (dev: DevClient, thread: string) => Promise<void>
}

const SMOKE_APP_PATH = { params: { name: SMOKE_APP } }

/** The smoke app's revision as the owner's Apps routes list it, or undefined when there is none. */
async function smokeRevision(dev: DevClient): Promise<number | undefined> {
  const apps = await dev
    .owner((api) => api.agentApps.list())
    .catch(() => {
      throw new Error('apps_list_failed')
    })
  return apps.find((app) => app.name === SMOKE_APP)?.revision
}

const deleteSmokeApp = (dev: DevClient): Promise<boolean> =>
  dev
    .owner((api) => api.agentApps.delete({ ...SMOKE_APP_PATH, payload: { confirm: SMOKE_APP } }))
    .then(
      () => true,
      // expected: a refused delete is the caller's `app_delete_failed`, with its answer in the step list
      () => false,
    )

/** The revision after the owner runs the smoke app's schedule now. */
async function runNow(dev: DevClient): Promise<number> {
  const payload = { kind: 'run', action: 'add' } as const
  const detail = await dev
    .owner((api) => api.agentApps.change({ ...SMOKE_APP_PATH, payload }))
    .catch(() => {
      throw new Error('app_run_failed')
    })
  return detail.revision
}

/**
 * Agent apps (ADR 0021): in a throwaway thread the agent builds a counter from exact code, the owner runs its
 * schedule now and its revision moves, then the owner deletes it and the thread closes.
 */
export async function appChecks(dev: DevClient, steps: ThreadSteps): Promise<{ readonly app: 'ok' }> {
  const { id: thread } = await dev
    .owner((api) => api.conversations.create({ payload: {} }))
    .catch(() => {
      throw new Error('app_thread_failed')
    })
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
    // expected: cleanup never hides the smoke's own failure; an app it cannot see is left alone
    if ((await smokeRevision(dev).catch(() => undefined)) !== undefined) await deleteSmokeApp(dev)
    await steps.close(dev, thread)
  }
}
