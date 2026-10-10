import { RoutineDefinition } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { Conflict } from '../http/errors.ts'
import { CredentialCipher } from '../mcp/cipher.ts'
import { RoutineStore, definitionOf } from './store.ts'
import type { RoutineRunner } from './runner.ts'
import type { Firing } from './runs.ts'
import { cronSlots, nextFire } from './time.ts'

export type RoutineSlot = { routineId: string; revision: number; firedAt: number }
type Schedule = { id: string; callback: string; time: number; payload: unknown }
const Pending = Schema.Struct({
  routineId: Schema.String,
  revision: Schema.Int,
  firedAt: Schema.Number,
  operationId: Schema.String,
  source: Schema.Literals(['manual', 'once', 'cron', 'event']),
  event: Schema.optional(
    Schema.Struct({
      eventId: Schema.String,
      subscriptionId: Schema.String,
      webhookId: Schema.String,
      dataSealed: Schema.String,
    }),
  ),
  schedule: Schema.optional(
    Schema.Struct({ expectedAt: Schema.Number, nextAt: Schema.NullOr(Schema.Number), missed: Schema.Int }),
  ),
})
export type RoutineSchedules = {
  list: () => Promise<Schedule[]>
  arm: (at: number, payload: RoutineSlot) => Promise<string>
  cancel: (id: string) => Promise<unknown>
  wake: (at: number) => Promise<void>
  deadline: (runId: string, at: number) => Promise<void>
}

/** Civil-day scanning collapses every missed slot into one newest catch-up, with an exact bounded count. */
export function dueSlot(definition: RoutineDefinition, first: number, at: number) {
  if (definition.trigger.kind !== 'cron')
    return { firedAt: first, nextAt: null, missed: 0, old: first < at - 86_400_000 }
  let firedAt = first
  let count = 0
  for (const slot of cronSlots(definition.trigger.expression, definition.timezone, first, at)) {
    firedAt = slot
    count += 1
  }
  return { firedAt, nextAt: nextFire(definition, at), missed: Math.max(0, count - 1), old: firedAt < at - 86_400_000 }
}

/** Native dated schedules only; app watermarks fence stale callbacks and edits before admission. */
export class RoutineScheduler {
  readonly #store: RoutineStore
  readonly #runner: RoutineRunner
  readonly #ports: RoutineSchedules
  readonly #cipher: Promise<CredentialCipher>
  constructor(
    storage: DurableObjectStorage,
    owner: () => string,
    runner: RoutineRunner,
    ports: RoutineSchedules,
    key: string,
  ) {
    // Agent names are assigned after construction, so the owner store is created lazily by callers.
    this.#store = new RoutineStore(drizzle(storage), owner())
    this.#runner = runner
    this.#ports = ports
    this.#cipher = CredentialCipher.fromBase64(key)
  }

  async reconcile(): Promise<void> {
    const rows = this.#store.scheduling()
    const jobs = (await this.#ports.list()).filter((job) => job.callback === 'runRoutine')
    for (const job of jobs) {
      if (!rows.some((row) => row.scheduleId === job.id && (row.state === 'active' || row.state === 'activating')))
        await this.#ports.cancel(job.id)
    }
    for (const row of rows) await this.#repair(row, jobs)
    if (rows.some((row) => row.state === 'active' || row.state === 'activating'))
      await this.#ports.wake(Date.now() + 60_000)
  }

  async #repair(row: ReturnType<RoutineStore['get']>, jobs: readonly Schedule[]): Promise<void> {
    if ((row.state !== 'activating' && row.state !== 'active') || row.confirmedAt === null) return
    if (row.pendingTrigger !== null) await this.drain(row.id, row.revision, row.pendingTrigger)
    const definition = definitionOf(row)
    if (definition.trigger.kind === 'event' || row.nextFireAt === null) return
    if (row.state === 'active' && row.nextFireAt <= Date.now()) {
      await this.fire({ routineId: row.id, revision: row.revision, firedAt: row.nextFireAt })
      return
    }
    if (jobs.some((job) => job.id === row.scheduleId)) return
    const id = await this.#ports.arm(row.nextFireAt, {
      routineId: row.id,
      revision: row.revision,
      firedAt: row.nextFireAt,
    })
    this.#store.markActive(row.id, row.revision, id, Date.now())
  }

  async drain(id: string, revision: number, sealed: string): Promise<void> {
    const text = await (await this.#cipher).decrypt(sealed, `routine-pending:${id}:${revision}`)
    const firing = Schema.decodeUnknownSync(Pending)(JSON.parse(text))
    try {
      await this.#runner.admit(
        firing,
        firing.firedAt < Date.now() - 86_400_000 ? 'Pending trigger expired after 24 hours' : undefined,
      )
      this.#store.clearPending(id, sealed, Date.now())
    } catch (error) {
      if (
        !(error instanceof Conflict) ||
        !['routine already running', 'running routine limit', 'event run spacing limit'].includes(error.reason)
      )
        throw error
    }
  }

  async fire(slot: RoutineSlot): Promise<void> {
    const row = this.#store.get(slot.routineId)
    if (
      row.revision !== slot.revision ||
      row.state !== 'active' ||
      row.nextFireAt !== slot.firedAt ||
      slot.firedAt > Date.now()
    )
      return
    const definition = definitionOf(row)
    if (definition.trigger.kind === 'event') return
    const due = dueSlot(definition, slot.firedAt, Date.now())
    const firing: Firing = {
      ...slot,
      firedAt: due.firedAt,
      operationId: `routine:${row.id}:${due.firedAt}`,
      source: definition.trigger.kind,
      schedule: { expectedAt: slot.firedAt, nextAt: due.nextAt, missed: due.missed },
    }
    try {
      await this.#runner.admit(firing, due.old ? 'Missed slot is older than the 24-hour catch-up window' : undefined)
    } catch (error) {
      if (
        !(error instanceof Conflict) ||
        (error.reason !== 'routine already running' && error.reason !== 'running routine limit')
      )
        throw error
      const sealed = await (
        await this.#cipher
      ).encrypt(JSON.stringify(firing), `routine-pending:${row.id}:${row.revision}`)
      this.#store.queue(
        { id: row.id, revision: row.revision, expectedAt: slot.firedAt, nextAt: due.nextAt, missed: due.missed },
        sealed,
        Date.now(),
      )
    }
    await this.#ports.wake(Date.now() + 1000)
  }
}
