import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import { Events } from '../mcp/service.ts'
import { confirmEvents, consumeEvent, reconcileEvents } from './events.ts'
import { sweepNotices } from './notices.ts'
import { notifyRoutine } from './notifications.ts'
import {
  DEADLINE_REACHED,
  answerRun,
  archiveRuns,
  deadlineRun,
  manualRun,
  reportRun,
  startRun,
  stopRun,
  wakeAt,
  wakeIn,
} from './runner.ts'
import { fire, reconcileSchedules } from './scheduler.ts'
import { RoutineControl, RoutineRuns } from './service.ts'
import type { RoutineStore } from './store.ts'

/** The native schedules, then the Events subscriptions, repaired to match the stored routines. */
const reconcileRoutines = Effect.andThen(reconcileSchedules, reconcileEvents)

/**
 * The routines' sweep: runs past their deadline stopped and admitted ones started, ended runs reported and their
 * Telegram notifications sent when due, the next sweep set by the nearest deadline, then reconciliation.
 */
const maintainRoutines = Effect.gen(function* () {
  const runs = yield* RoutineRuns
  const live = yield* runs.live
  for (const record of live) {
    if (record.deadlineAt <= (yield* Clock.currentTimeMillis)) yield* stopRun(record.id, DEADLINE_REACHED)
    else if (record.state === 'admitted') yield* startRun(record)
  }
  const reports = yield* runs.unfinishedReports
  for (const record of reports) yield* reportRun(record)
  const notifications = yield* runs.notifications(yield* Clock.currentTimeMillis)
  for (const record of notifications) yield* notifyRoutine(record)
  if (notifications.length > 0) yield* wakeIn(30_000)
  yield* sweepNotices
  const now = yield* Clock.currentTimeMillis
  const next = live.filter((record) => record.deadlineAt > now).map((record) => record.deadlineAt)
  if (next.length > 0 || reports.length === 100) yield* wakeAt(Math.min(now + 60_000, ...next))
  yield* reconcileRoutines
})

/** Everything the routines' programs read, which their service captures once from its layer. */
export type RoutineControlServices = Effect.Services<
  [
    ReturnType<typeof manualRun>,
    typeof reconcileRoutines,
    ReturnType<typeof confirmEvents>,
    ReturnType<typeof archiveRuns>,
    ReturnType<typeof stopRun>,
    ReturnType<typeof answerRun>,
    ReturnType<typeof startRun>,
    ReturnType<typeof deadlineRun>,
    ReturnType<typeof fire>,
    typeof maintainRoutines,
    ReturnType<typeof consumeEvent>,
  ][number]
>

/**
 * The routines' runtime (`RoutineControl`) over the services its layer was built with: each method runs its program
 * with them, so a caller's requirements never include them. The routine trigger is registered with Events here;
 * `store` writes a busy routine's pending trigger inside a delivery's acknowledgement.
 */
export const makeRoutineControl = (store: RoutineStore) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<RoutineControlServices>()
    const provided = <A>(program: Effect.Effect<A, AppError, RoutineControlServices>) =>
      Effect.provideContext(program, context)
    yield* (yield* Events).register('routine-trigger', (event) => provided(consumeEvent(store, event)))
    return RoutineControl.of({
      manual: (id, input) => provided(manualRun(id, input)),
      reconcile: provided(reconcileRoutines),
      confirmEvents: (id, revision) => provided(confirmEvents(id, revision)),
      archive: (routineId) => provided(archiveRuns(routineId)),
      stop: (id, reason = 'Stopped by owner') => provided(stopRun(id, reason)),
      answer: (session, operationId, text) => provided(answerRun(session, operationId, text)),
      start: (record, answer) => provided(startRun(record, answer)),
      deadline: (id) => provided(deadlineRun(id)),
      fire: (slot) => provided(fire(slot)),
      maintain: provided(maintainRoutines),
    })
  })
