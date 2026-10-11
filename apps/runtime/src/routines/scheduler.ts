import { type RoutineDefinition, handOverOf } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { type AppError, Conflict, attempt, toAppError } from '../http/errors.ts'
import { Cipher } from '../mcp/cipher.ts'
import { AgentInput } from '../runtime/input.ts'
import { postReminder } from './notices.ts'
import { admit, wakeIn } from './runner.ts'
import type { Firing } from './runs.ts'
import { Routines } from './service.ts'
import { type RoutineRow, definitionOf } from './store.ts'
import { cronSlots, nextFire } from './time.ts'

// Native dated schedules only: the app's watermarks fence stale callbacks and edits before admission.

export type RoutineSlot = { routineId: string; revision: number; firedAt: number }
type Schedule = { id: string; callback: string; time: number; payload: unknown }
const Pending = Schema.fromJsonString(
  Schema.Struct({
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
  }),
)

/** The agent's native schedules as the routines use them, on whole seconds (`routineSchedulePorts`, agent.ts). */
export type RoutineSchedules = {
  /** Every schedule the agent holds, whatever its callback. */
  readonly list: () => Promise<Schedule[]>
  /** A slot's `runRoutine` alarm at `at` (epoch ms); answers the schedule's id. */
  readonly arm: (at: number, payload: RoutineSlot) => Promise<string>
  readonly cancel: (id: string) => Promise<unknown>
  /** The routines' sweep (`routinesWake`) at `at`, unless one is due sooner. */
  readonly wake: (at: number) => Promise<void>
  /** A run's deadline alarm (`runRoutineDeadline`) at `at`. */
  readonly deadline: (runId: string, at: number) => Promise<void>
}

const DAY = 86_400_000

/** A firing that found its routine at a cap: it waits, sealed, for the next sweep to drain it. */
const busy = (reasons: readonly string[]) => (error: AppError) =>
  error instanceof Conflict && reasons.includes(error.reason)
const slotBusy = busy(['routine already running', 'running routine limit'])
const drainBusy = busy(['routine already running', 'running routine limit', 'event run spacing limit'])

const live = (row: RoutineRow) => row.state === 'active' || row.state === 'activating'

/** Civil-day scanning collapses every missed slot into one newest catch-up, with an exact bounded count. */
export function dueSlot(definition: RoutineDefinition, first: number, at: number) {
  if (definition.trigger.kind !== 'cron') return { firedAt: first, nextAt: null, missed: 0, old: first < at - DAY }
  let firedAt = first
  let count = 0
  for (const slot of cronSlots(definition.trigger.expression, definition.timezone, first, at)) {
    firedAt = slot
    count += 1
  }
  return { firedAt, nextAt: nextFire(definition, at), missed: Math.max(0, count - 1), old: firedAt < at - DAY }
}

/** A firing that waited while its routine was busy, sealed under the routine's revision. */
const sealedFiring = (id: string, revision: number, firing: Firing) =>
  Effect.gen(function* () {
    const cipher = yield* Cipher
    return yield* attempt(() => cipher.encrypt(JSON.stringify(firing), `routine-pending:${id}:${revision}`))
  })

/**
 * The firing that waited while its routine was busy, admitted now: recorded skipped once it is a day old, and kept
 * waiting while the routine is still busy.
 */
const drain = Effect.fn('routines.drain')(function* (id: string, revision: number, sealed: string) {
  const cipher = yield* Cipher
  const text = yield* attempt(() => cipher.decrypt(sealed, `routine-pending:${id}:${revision}`))
  const firing = yield* Schema.decodeUnknownEffect(Pending)(text).pipe(Effect.mapError(toAppError))
  const at = yield* Clock.currentTimeMillis
  const routines = yield* Routines
  yield* admit(firing, firing.firedAt < at - DAY ? 'Pending trigger expired after 24 hours' : undefined).pipe(
    Effect.andThen(Effect.flatMap(Clock.currentTimeMillis, (now) => routines.clearPending(id, sealed, now))),
    // expected: a routine still busy keeps its firing sealed; the next sweep drains it again
    Effect.catchIf(drainBusy, () => Effect.void),
  )
})

/**
 * A native schedule's slot is due. A stale callback (an edited, paused or already advanced routine) does nothing; a
 * busy routine keeps the newest catch-up sealed, to be drained by the next sweep.
 */
export const fire = Effect.fn('routines.fire')(function* (slot: RoutineSlot) {
  const routines = yield* Routines
  const row = yield* routines.get(slot.routineId)
  const now = yield* Clock.currentTimeMillis
  if (row.revision !== slot.revision || row.state !== 'active' || row.nextFireAt !== slot.firedAt || slot.firedAt > now)
    return
  const definition = definitionOf(row)
  if (definition.trigger.kind === 'event') return
  const due = dueSlot(definition, slot.firedAt, now)
  const schedule = { expectedAt: slot.firedAt, nextAt: due.nextAt, missed: due.missed }
  // A routine that hands nothing over only reminds the owner (ADR 0041): a reminder at the slot, no run.
  if (handOverOf(definition) === undefined) {
    if (!due.old) yield* postReminder(row, definition, due.firedAt)
    yield* routines.advance({ id: row.id, revision: row.revision, ...schedule }, now)
    return yield* wakeIn(1000)
  }
  const firing: Firing = {
    ...slot,
    firedAt: due.firedAt,
    operationId: `routine:${row.id}:${due.firedAt}`,
    source: definition.trigger.kind,
    schedule,
  }
  const queue = Effect.gen(function* () {
    const sealed = yield* sealedFiring(row.id, row.revision, firing)
    yield* routines.queue({ id: row.id, revision: row.revision, ...schedule }, sealed, yield* Clock.currentTimeMillis)
  })
  yield* admit(firing, due.old ? 'Missed slot is older than the 24-hour catch-up window' : undefined).pipe(
    // expected: a busy routine keeps the newest catch-up sealed, for the next sweep to drain
    Effect.catchIf(slotBusy, () => queue),
  )
  yield* wakeIn(1000)
})

/** One routine's schedule: a waiting firing drained, a missed slot fired, a missing alarm armed. */
const repair = Effect.fn('routines.repairSchedule')(function* (row: RoutineRow, jobs: readonly Schedule[]) {
  if (!live(row) || row.confirmedAt === null) return
  if (row.pendingTrigger !== null) yield* drain(row.id, row.revision, row.pendingTrigger)
  const firedAt = row.nextFireAt
  if (definitionOf(row).trigger.kind === 'event' || firedAt === null) return
  const slot = { routineId: row.id, revision: row.revision, firedAt }
  if (row.state === 'active' && firedAt <= (yield* Clock.currentTimeMillis)) return yield* fire(slot)
  if (jobs.some((job) => job.id === row.scheduleId)) return
  const { routineSchedules } = yield* AgentInput
  const id = yield* attempt(() => routineSchedules.arm(firedAt, slot))
  yield* (yield* Routines).markActive(row.id, row.revision, id, yield* Clock.currentTimeMillis)
})

/** The native schedules repaired to match the stored routines: stale alarms cancelled, each live routine repaired. */
export const reconcileSchedules = Effect.gen(function* () {
  const { routineSchedules } = yield* AgentInput
  const rows = yield* (yield* Routines).scheduling
  const jobs = (yield* attempt(() => routineSchedules.list())).filter((job) => job.callback === 'runRoutine')
  for (const job of jobs)
    if (!rows.some((row) => row.scheduleId === job.id && live(row)))
      yield* attempt(() => routineSchedules.cancel(job.id))
  for (const row of rows) yield* repair(row, jobs)
  if (rows.some(live)) yield* wakeIn(60_000)
})
