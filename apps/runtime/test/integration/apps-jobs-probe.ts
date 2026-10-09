import { createRegistry } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Predicate from 'effect/Predicate'
import { agentApps } from '../../src/agent-apps/engine.ts'
import { JOB_CALLBACK, type JobSchedules, type JobSlot } from '../../src/agent-apps/jobs.ts'
import type { AppRunner } from '../../src/agent-apps/queue.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { KeyedLock } from '../../src/observability/lock.ts'
import { type AgentFetch, type OwnerClient, callOwner } from './owner-api.ts'

/** A runtime with only the per-key lock, for the apps engines a probe makes outside an agent's own runtime. */
const probeRuntime = ManagedRuntime.make(KeyedLock.layer)
export const probeLocal: AppRunner = (program) => probeRuntime.runPromise(program)

/** Native schedules kept in memory, for probes whose apps declare none. */
export function memorySchedules(): JobSchedules {
  const armed = new Map<string, JobSlot>()
  let next = 0
  return {
    list: async () => [...armed.keys()].map((id) => ({ id, callback: JOB_CALLBACK })),
    arm: async (_at, slot) => {
      next += 1
      armed.set(String(next), slot)
      return String(next)
    },
    cancel: async (id) => armed.delete(id),
  }
}

const TICKER = `import { defineApp, s } from '@goblin/app'

export default defineApp({
  name: 'ticker',
  title: 'Ticker',
  description: 'Counts ticks.',
  state: { schema: s.object({ ticks: s.number({ int: true }) }), initial: { ticks: 0 } },
  schedules: [
    { action: 'tick', every: '15m', input: { by: 1 } },
    { action: 'flaky', every: '1d', at: '06:30', input: {} },
  ],
  actions: {
    tick: {
      description: 'One tick.',
      input: s.object({ by: s.number({ int: true }) }),
      run: (input, ctx) => ({ ticks: ctx.state.ticks + input.by }),
    },
    flaky: {
      description: 'Fails for now.',
      input: s.object({}),
      run: () => {
        throw new Error('flaky failed')
      },
    },
  },
})
`

const MINUTE = 60_000

/** The ticker app on a clock a month ahead (so nothing fires by itself), with the agent's authority switchable. */
function jobsBench(storage: DurableObjectStorage, env: RuntimeEnv, owner: string, schedules: JobSchedules) {
  const clock = { now: Math.ceil((Date.now() + 30 * 24 * 60 * MINUTE) / (60 * MINUTE)) * 60 * MINUTE + 7 * MINUTE }
  const authority: { blocked: string | undefined } = { blocked: undefined }
  const apps = agentApps(storage, env, () => owner, { schedules, local: probeLocal, now: () => clock.now })
  apps.attach(createRegistry())
  apps.restore()
  apps.connect({
    authorizeCall: async () => undefined,
    tool: async () => null,
    complete: async () => '',
    notify: async () => undefined,
    blocked: async () => authority.blocked,
  })
  const job = (action: string) => apps.jobs.list('ticker').find((each) => each.action === action)
  const due = (action: string) => job(action)?.nextAt ?? 0
  return {
    apps,
    clock,
    authority,
    job,
    due,
    build: (source: string) =>
      apps.build({ name: 'ticker', files: { 'app.ts': source } }, { session: '1', callId: 'jobs-1' }),
    fire: (action: string, at = due(action)) => apps.jobs.fire({ app: 'ticker', action, at }),
    armed: async () => (await schedules.list()).filter((each) => each.callback === JOB_CALLBACK).map((each) => each.id),
    ticks: () => {
      const state = apps.store.state('ticker')?.state
      return typeof state === 'object' && state !== null && 'ticks' in state ? state.ticks : undefined
    },
  }
}
type Bench = ReturnType<typeof jobsBench>

/** A due run, a stale callback, a catch-up two hours late, and a run while authority lapsed. */
async function runs(bench: Bench) {
  const { clock, authority, job } = bench
  const slot = bench.due('tick')
  clock.now = slot + 2000
  await bench.fire('tick')
  const afterTick = { ticks: bench.ticks(), job: job('tick') }
  await bench.fire('tick', slot)
  const afterStale = bench.ticks()
  clock.now += 2 * 60 * MINUTE
  await bench.fire('tick')
  const caughtUp = { ticks: bench.ticks(), inMs: bench.due('tick') - clock.now }
  authority.blocked = 'waiting for the owner (test)'
  clock.now = bench.due('tick') + 1000
  await bench.fire('tick')
  authority.blocked = undefined
  return { afterTick, afterStale, caughtUp, waiting: { ticks: bench.ticks(), job: job('tick') } }
}

/** Ten failures in a row: each waits longer, the tenth pauses the schedule and its native schedule goes. */
async function failures(bench: Bench) {
  const waits: number[] = []
  for (let attempt = 0; attempt < 10; attempt += 1) {
    bench.clock.now = bench.due('flaky') + 1000
    await bench.fire('flaky')
    const after = bench.job('flaky')
    if (after?.paused === null) waits.push(after.nextAt - bench.clock.now)
  }
  const paused = bench.job('flaky')
  await bench.apps.jobs.reconcile()
  return { waits, paused, armedPaused: (await bench.armed()).length }
}

/** A new release resumes the paused schedule; the agent's own callback runs it; a release that drops one removes it. */
async function releases(bench: Bench, fire: (slot: JobSlot) => Promise<void>) {
  const fixed = TICKER.replace("throw new Error('flaky failed')", 'return { ticks: 0 }')
  await bench.build(fixed)
  const resumed = bench.job('flaky')
  const armedResumed = (await bench.armed()).length
  const slot = bench.due('flaky')
  await fire({ app: 'ticker', action: 'flaky', at: slot })
  const viaAgent = bench.job('flaky')
  await bench.build(fixed.replace("    { action: 'tick', every: '15m', input: { by: 1 } },\n", ''))
  return {
    resumed,
    armedResumed,
    viaAgent: { changed: viaAgent?.nextAt !== slot, status: viaAgent?.status },
    afterDrop: bench.apps.jobs.list('ticker').map((each) => each.action),
    armedAfterDrop: (await bench.armed()).length,
  }
}

/** The agent object as the owner reaches it: its native job callback, and the owner API over its own `fetch`. */
export type AgentPort = AgentFetch & { readonly fire: (slot: JobSlot) => Promise<void> }

/** An owner API call's value, or the tag of the failure it answered. */
const settle = <A, E>(agent: AgentFetch, call: (api: OwnerClient) => Effect.Effect<A, E>): Promise<A | string> =>
  callOwner(agent, (api) =>
    call(api).pipe(
      // expected: a typed failure is the probe's answer, read as its tag
      Effect.catch((error) =>
        Effect.succeed(Predicate.hasProperty(error, '_tag') && Predicate.isString(error._tag) ? error._tag : 'failed'),
      ),
    ),
  )

/** The flaky schedule of an app detail. */
const flakyOf = (detail: unknown) => {
  if (typeof detail !== 'object' || detail === null || !('jobs' in detail) || !Array.isArray(detail.jobs)) return detail
  return detail.jobs.find((job: { action?: string }) => job.action === 'flaky')
}

/** How many R2 objects the agent keeps. */
async function objects(bucket: R2Bucket, owner: string): Promise<number> {
  return (await bucket.list({ prefix: `agents/${owner}/` })).objects.length
}

/**
 * The owner manages the app through the agent's owner API: pause, resume and run a schedule now, move its home (only to
 * an open conversation), see it listed, and delete it only when they type its name: its schedules, files (R2 too) and
 * rows go.
 */
async function management(bench: Bench, agent: AgentPort, bucket: R2Bucket, owner: string) {
  // Each change is its own call: the client takes one member of the change union at a time.
  const apps = (call: (api: OwnerClient['agentApps']) => Effect.Effect<unknown, unknown>) =>
    settle(agent, (api) => call(api.agentApps))
  const params = { name: 'ticker' }
  const remove = (confirm: string) => apps((api) => api.delete({ params, payload: { confirm } }))
  const files = bench.apps.files('ticker')
  await files.write('/big.txt', 'x'.repeat(200 * 1024))
  await files.write('/small.txt', 'hi')
  const paused = flakyOf(
    await apps((api) => api.change({ params, payload: { kind: 'pause', action: 'flaky', paused: true } })),
  )
  const armedPaused = (await bench.armed()).length
  const resumed = flakyOf(
    await apps((api) => api.change({ params, payload: { kind: 'pause', action: 'flaky', paused: false } })),
  )
  const ran = flakyOf(await apps((api) => api.change({ params, payload: { kind: 'run', action: 'flaky' } })))
  const moved = await apps((api) => api.change({ params, payload: { kind: 'home', conversation: '1' } }))
  const badHome = await apps((api) => api.change({ params, payload: { kind: 'home', conversation: '999' } }))
  const listed = await apps((api) => api.list())
  const refused = await remove('nope')
  const before = await objects(bucket, owner)
  const removed = await remove('ticker')
  return {
    manage: {
      paused,
      armedPaused,
      resumed,
      ran,
      home: typeof moved === 'object' && moved !== null && 'home' in moved ? moved.home : moved,
      badHome,
      listed,
      refused,
      objects: { before, after: await objects(bucket, owner) },
      removed,
      gone: {
        app: bench.apps.store.app('ticker') === undefined,
        jobs: bench.apps.jobs.list('ticker').length,
        armed: (await bench.armed()).length,
        files: await files.size(),
      },
    },
  }
}

/**
 * Agent app jobs (ADR 0021) on the agent object's own native schedules: a build arms one schedule per scheduled
 * action; a due run moves the state and arms the next slot; a stale callback runs nothing; a late run catches up once;
 * a lapsed authority waits; failures back off and pause the schedule after ten, and a new release resumes it; a
 * schedule a release drops goes. The agent's own callback runs the same job, and the owner manages and deletes it.
 */
export async function appsJobsProbe(
  storage: DurableObjectStorage,
  env: RuntimeEnv,
  owner: string,
  schedules: JobSchedules,
  agent: AgentPort,
) {
  const bench = jobsBench(storage, env, owner, schedules)
  const wrongSource = TICKER.replace("every: '15m'", "every: '2m'").replace("action: 'flaky'", "action: 'nope'")
  const wrong = await bench.build(wrongSource)
  const built = await bench.build(TICKER)
  const first = bench.apps.jobs.list('ticker').map((each) => ({
    action: each.action,
    every: each.every,
    at: each.at,
    inMs: each.nextAt - bench.clock.now,
    time: new Date(each.nextAt).toISOString().slice(11, 16),
  }))
  const armedFirst = (await bench.armed()).length
  const result = {
    wrong: wrong.status === 'failed' ? wrong.problems.map((problem) => problem.message) : wrong.status,
    built: built.status,
    first,
    armedFirst,
    ...(await runs(bench)),
    ...(await failures(bench)),
    ...(await releases(bench, agent.fire)),
    summary: bench.apps.summary(),
    ...(await management(bench, agent, env.FILES, owner)),
  }
  for (const id of await bench.armed()) await schedules.cancel(id)
  return result
}
