import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { Conflict, NotFound } from '../http/errors.ts'
import { appAgentJobs } from '../storage/schema.ts'
import { type Every, type Manifest, type Schedule, everyOf } from './manifest.ts'
import { problemText } from './queue.ts'
import type { AgentAppStore } from './store.ts'
import { readJobInput } from './stored.ts'

const MINUTE = 60_000

/** Each schedule's period. */
const PERIOD: Readonly<Record<Every, number>> = {
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': 60 * MINUTE,
  '3h': 180 * MINUTE,
  '6h': 360 * MINUTE,
  '12h': 720 * MINUTE,
  '1d': 1440 * MINUTE,
}

/**
 * What jobs may do (ADR 0021): runs per app per UTC day, job runs at once per agent, failures in a row before a
 * schedule pauses, the first and longest wait after a failure, and the wait when every run slot is taken.
 */
export const JOB_LIMITS = {
  daily: 96,
  running: 2,
  pauseAfter: 10,
  backoff: 15 * MINUTE,
  maxBackoff: 360 * MINUTE,
  busy: MINUTE,
} as const

/** The callback the agent object arms for a job. */
export const JOB_CALLBACK = 'runAppJob'

type When = { readonly every: Every; readonly at: string | null }

/** Where a schedule's slots fall past each period's start: a daily one at its time of day (UTC). */
function offsetOf(when: When): number {
  if (when.at === null) return 0
  const [hours = 0, minutes = 0] = when.at.split(':').map(Number)
  return (hours * 60 + minutes) * MINUTE
}

/** The newest slot of a schedule at or before `now`: the one a late run catches up, however many it missed. */
export function lastSlot(when: When, now: number): number {
  const period = PERIOD[when.every]
  const offset = offsetOf(when)
  return Math.floor((now - offset) / period) * period + offset
}

/** The first slot of a schedule after `now`. */
export const nextSlot = (when: When, now: number): number => lastSlot(when, now) + PERIOD[when.every]

/** How long a job waits after its `failures`-th failure in a row: 15 minutes, doubling, at most six hours. */
export const backoff = (failures: number): number =>
  Math.min(JOB_LIMITS.backoff * 2 ** Math.max(failures - 1, 0), JOB_LIMITS.maxBackoff)

/** What the agent object arms: the job, and the time it is due (which tells a stale callback from a live one). */
export type JobSlot = { readonly app: string; readonly action: string; readonly at: number }

/** The agent object's native schedules, as jobs use them. */
export type JobSchedules = {
  readonly list: () => Promise<readonly { readonly id: string; readonly callback: string }[]>
  readonly arm: (at: number, slot: JobSlot) => Promise<string>
  readonly cancel: (id: string) => Promise<unknown>
}

export type JobRow = typeof appAgentJobs.$inferSelect

/** A schedule as the owner and the agent see it. */
export type JobView = Pick<JobRow, 'action' | 'every' | 'at' | 'nextAt' | 'lastAt' | 'failures' | 'paused'> & {
  readonly status: JobRow['lastStatus']
  readonly error: string | null
}

export const jobView = (row: JobRow): JobView => ({
  action: row.action,
  every: row.every,
  at: row.at,
  nextAt: row.nextAt,
  lastAt: row.lastAt,
  failures: row.failures,
  paused: row.paused,
  status: row.lastStatus,
  error: row.lastError,
})

type Patch = Partial<Omit<JobRow, 'app' | 'action'>>

class JobStore {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }
  all(): readonly JobRow[] {
    return this.#db.select().from(appAgentJobs).all()
  }
  get(app: string, action: string): JobRow | undefined {
    return this.#db.select().from(appAgentJobs).where(this.#key(app, action)).get()
  }
  insert(row: JobRow): void {
    this.#db.insert(appAgentJobs).values(row).run()
  }
  update(app: string, action: string, patch: Patch): void {
    this.#db.update(appAgentJobs).set(patch).where(this.#key(app, action)).run()
  }
  remove(app: string, action: string): void {
    this.#db.delete(appAgentJobs).where(this.#key(app, action)).run()
  }
  #key(app: string, action: string) {
    return and(eq(appAgentJobs.app, app), eq(appAgentJobs.action, action))
  }
}

type JobsDeps = {
  readonly db: DrizzleSqliteDODatabase
  readonly store: AgentAppStore
  readonly manifest: (release: string) => Manifest
  /** Runs one of an app's actions as a job, with its operation id. */
  readonly run: (app: string, action: string, input: unknown, op: string) => Promise<unknown>
  /** Why the agent may not act on its own now, or undefined. */
  readonly blocked: () => Promise<string | undefined>
  readonly schedules: JobSchedules
  readonly now: () => number
  readonly changed: (app: string) => void
}

type Wanted = { readonly app: string; readonly release: string; readonly schedule: Schedule }

/**
 * Agent apps' schedules (ADR 0021): one native dated schedule per scheduled action, armed for its next slot and
 * reconciled whenever a release activates or rolls back and when the agent starts. A late run catches up only the
 * newest slot it missed. A failure waits longer each time and pauses the schedule after ten in a row, until a new
 * release; while the owner's plan or resident authority lapses, runs are skipped and recorded as waiting.
 */
export class AppJobs {
  readonly #deps: JobsDeps
  readonly #jobs: JobStore
  #running = 0

  constructor(deps: JobsDeps) {
    this.#deps = deps
    this.#jobs = new JobStore(deps.db)
  }

  /** An app's schedules. */
  list(app: string): readonly JobView[] {
    return this.#jobs
      .all()
      .filter((row) => row.app === app)
      .map(jobView)
  }

  /** The owner pauses a schedule (its native schedule goes) or resumes it from its next slot. */
  async pause(app: string, action: string, paused: boolean): Promise<void> {
    const row = this.#required(app, action)
    if (paused) {
      this.#jobs.update(app, action, { paused: 'owner', scheduleId: null })
      if (row.scheduleId !== null) await this.#deps.schedules.cancel(row.scheduleId)
    } else if (row.paused !== null) {
      const nextAt = nextSlot(row, this.#deps.now())
      this.#jobs.update(app, action, { paused: null, failures: 0, nextAt, scheduleId: null })
      await this.#arm({ ...row, paused: null, failures: 0, nextAt, scheduleId: null })
    }
    this.#deps.changed(app)
  }

  /**
   * The owner runs a schedule's action now, outside its slots: it counts toward the day's runs and moves no slot. This
   * is its start: the stored input and the operation id, once today's runs allow one more. `finishNow` keeps how it
   * went as the schedule's last run.
   */
  startNow(app: string, action: string): { readonly input: string; readonly op: string } {
    const row = this.#required(app, action)
    const now = this.#deps.now()
    if (!this.#deps.store.spend(app, 'job', 1, JOB_LIMITS.daily, now))
      throw new Conflict({ reason: `${app} ran ${String(JOB_LIMITS.daily)} jobs today already` })
    return { input: row.input, op: `job:${app}:${action}:now:${String(now)}` }
  }

  /** How the owner's run now went, kept as the schedule's last run; a failure is that status, not thrown. */
  finishNow(
    app: string,
    action: string,
    outcome: { readonly ok: true } | { readonly ok: false; readonly error: unknown },
  ) {
    const lastAt = this.#deps.now()
    if (outcome.ok) this.#jobs.update(app, action, { lastAt, lastStatus: 'ok', lastError: null })
    else {
      const lastError = problemText(outcome.error).slice(0, 1000)
      this.#jobs.update(app, action, { lastAt, lastStatus: 'failed', lastError })
    }
    this.#deps.changed(app)
  }

  /** Takes every schedule of a deleted app away, its native schedules first. */
  async removeApp(app: string): Promise<void> {
    for (const row of this.#jobs.all().filter((each) => each.app === app)) {
      if (row.scheduleId !== null) await this.#deps.schedules.cancel(row.scheduleId)
      this.#jobs.remove(app, row.action)
    }
  }

  #required(app: string, action: string): JobRow {
    const row = this.#jobs.get(app, action)
    if (row === undefined) throw new NotFound({ what: `${app} has no schedule for ${action}` })
    return row
  }

  /** Makes the stored schedules and the armed native ones match what the active releases declare. */
  async reconcile(): Promise<void> {
    const now = this.#deps.now()
    const wanted = new Map(this.#wanted().map((want) => [`${want.app}/${want.schedule.action}`, want]))
    for (const row of this.#jobs.all())
      if (!wanted.has(`${row.app}/${row.action}`)) {
        this.#jobs.remove(row.app, row.action)
        this.#deps.changed(row.app)
      }
    for (const want of wanted.values()) this.#keep(want, now)
    const armed = (await this.#deps.schedules.list()).filter((job) => job.callback === JOB_CALLBACK)
    const live = this.#jobs.all().filter((row) => row.paused === null)
    for (const job of armed)
      if (!live.some((row) => row.scheduleId === job.id)) await this.#deps.schedules.cancel(job.id)
    for (const row of live) if (!armed.some((job) => job.id === row.scheduleId)) await this.#arm(row)
  }

  /** A native schedule fired: run the job if it is still the one armed, then arm its next run. */
  async fire(slot: JobSlot): Promise<void> {
    const now = this.#deps.now()
    const row = this.#jobs.get(slot.app, slot.action)
    if (row === undefined || row.paused !== null || row.nextAt !== slot.at) return
    if (this.#running >= JOB_LIMITS.running) {
      await this.#settle(row, {}, now + JOB_LIMITS.busy)
      return
    }
    const blocked = await this.#deps.blocked()
    if (blocked !== undefined) {
      await this.#settle(row, { lastAt: now, lastStatus: 'waiting', lastError: blocked }, nextSlot(row, now))
      return
    }
    if (!this.#deps.store.spend(row.app, 'job', 1, JOB_LIMITS.daily, now)) {
      const skipped = `${String(JOB_LIMITS.daily)} job runs today already`
      await this.#settle(row, { lastAt: now, lastStatus: 'skipped', lastError: skipped }, nextSlot(row, now))
      return
    }
    await this.#run(row, now)
  }

  async #run(row: JobRow, now: number): Promise<void> {
    this.#running += 1
    try {
      const input = readJobInput(row.input)
      await this.#deps.run(row.app, row.action, input, `job:${row.app}:${row.action}:${String(lastSlot(row, now))}`)
      const done = this.#deps.now()
      await this.#settle(row, { lastAt: done, lastStatus: 'ok', lastError: null, failures: 0 }, nextSlot(row, done))
    } catch (cause) {
      // expected: the run's failure is kept with the app's events and backs the schedule off, pausing it after ten
      const done = this.#deps.now()
      const failures = row.failures + 1
      const error = problemText(cause).slice(0, 1000)
      this.#deps.store.event(row.app, 'error', `job ${row.action}: ${error}`, done)
      const failed = { lastAt: done, lastStatus: 'failed', lastError: error, failures } as const
      if (failures < JOB_LIMITS.pauseAfter) await this.#settle(row, failed, done + backoff(failures))
      else {
        await this.#settle(row, { ...failed, paused: 'failures', scheduleId: null }, undefined)
        const paused = `job ${row.action} paused after ${String(failures)} failures in a row; a new release resumes it`
        this.#deps.store.event(row.app, 'error', paused, done)
      }
    } finally {
      this.#running -= 1
    }
  }

  /** Records a run and arms the next one at `next`, unless the schedule changed or paused meanwhile. */
  async #settle(row: JobRow, patch: Patch, next: number | undefined): Promise<void> {
    const current = this.#jobs.get(row.app, row.action)
    if (current === undefined) return
    const same = current.nextAt === row.nextAt && current.paused === null
    this.#jobs.update(row.app, row.action, { ...patch, ...(same && next !== undefined && { nextAt: next }) })
    this.#deps.changed(row.app)
    const armed = this.#jobs.get(row.app, row.action)
    if (same && next !== undefined && armed !== undefined) await this.#arm(armed)
  }

  /** Arms the native schedule for a stored job's next run (at once when that time has passed). */
  async #arm(row: JobRow): Promise<void> {
    const at = Math.max(row.nextAt, this.#deps.now() + 1000)
    const id = await this.#deps.schedules.arm(at, { app: row.app, action: row.action, at: row.nextAt })
    this.#jobs.update(row.app, row.action, { scheduleId: id })
  }

  /** Every schedule the apps' active releases declare. */
  #wanted(): readonly Wanted[] {
    return this.#deps.store.apps().flatMap((app) =>
      this.#deps.manifest(app.activeRelease).schedules.map((schedule) => ({
        app: app.name,
        release: app.activeRelease,
        schedule,
      })),
    )
  }

  /**
   * Stores a declared schedule: new or changed, it starts at its next slot; a new release clears its failures and
   * lifts a pause the failures caused (not one the owner chose).
   */
  #keep({ app, release, schedule }: Wanted, now: number): void {
    const input = JSON.stringify(schedule.input ?? {})
    const row = this.#jobs.get(app, schedule.action)
    const when = { every: everyOf(schedule.every), at: schedule.at }
    const fresh = { ...when, input, release, failures: 0 }
    if (row === undefined) {
      this.#jobs.insert({
        app,
        action: schedule.action,
        ...fresh,
        nextAt: nextSlot(when, now),
        scheduleId: null,
        lastAt: null,
        lastStatus: null,
        lastError: null,
        paused: null,
      })
    } else if (row.every !== schedule.every || row.at !== schedule.at || row.input !== input) {
      const paused = row.paused === 'owner' ? 'owner' : null
      this.#jobs.update(app, schedule.action, { ...fresh, nextAt: nextSlot(when, now), scheduleId: null, paused })
    } else if (row.release !== release) {
      const lifted = row.paused === 'failures'
      this.#jobs.update(app, schedule.action, {
        release,
        failures: 0,
        ...(lifted && { paused: null, nextAt: nextSlot(when, now), scheduleId: null }),
      })
    } else return
    this.#deps.changed(app)
  }
}
