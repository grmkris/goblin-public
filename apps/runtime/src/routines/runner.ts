import { type RoutineManualRun, handOverOf } from '@goblin/contracts'
import type { FlowStatus, FlowVia } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { nextInt } from 'effect/Random'
import { requirePlan } from '../billing/gates.ts'
import { requireBudget } from '../budget.ts'
import { Chats, Conversations } from '../chats/service.ts'
import { Conflict, InvalidInput, attempt, toAppError } from '../http/errors.ts'
import { Cipher } from '../mcp/cipher.ts'
import { requireResident } from '../mcp/service.ts'
import { Models } from '../models.ts'
import { FlowEvents } from '../observability/flows.ts'
import { reportFailure, safeErrorType } from '../observability/report.ts'
import { BACKGROUND } from '../pi/context.ts'
import { type PiFailure, PiSessions } from '../pi/sessions.ts'
import { sha256Hex } from '../runtime/digest.ts'
import { AgentInput } from '../runtime/input.ts'
import { notifyReport } from './notices.ts'
import { personaHold, runPersona } from './persona.ts'
import type { Firing, RoutineRun } from './runs.ts'
import { type RoutineAnswer, RoutineRuns, RoutineUsage, Routines } from './service.ts'
import { definitionOf } from './store.ts'

// A routine run's life on the app side: admission, the handoff to Pi, the owner's answer, stopping and the frozen
// report. Pi executes the run; these programs repair the handoffs to it and never wait on the model.

/** Why a run past its deadline is stopped. */
export const DEADLINE_REACHED = 'Absolute routine deadline reached'

const skipAs = (error: { readonly _tag: string }) => Effect.succeed(error._tag)
/** A Pi call's failure as the routines take one: Pi's own error through `toAppError`. */
const piFailure = (failure: PiFailure) => Effect.fail(toAppError(failure.cause))

const VIA: Readonly<Record<Firing['source'], FlowVia>> = {
  manual: 'app',
  once: 'schedule',
  cron: 'schedule',
  event: 'mcp',
}
const failure = (errorType: string | undefined) => (errorType === undefined ? {} : { errorType })

/**
 * A firing as a flow (ADR 0024): admitted (`ok`), recorded as skipped or turned away busy (`refused`), the same
 * operation admitted before (`replayed`), or an admission that failed (`error`).
 */
const fireFlow = (firing: Firing, status: FlowStatus, errorType?: string) =>
  FlowEvents.record({
    flow: 'routine_fire',
    via: VIA[firing.source],
    actor: firing.source === 'manual' ? 'owner' : 'routine',
    operationId: firing.operationId,
    status,
    ...failure(errorType),
  })

/** A run's frozen report into its Topic's Conversation as a flow, under the run's operation. */
const reportFlow = (record: RoutineRun, topic: number | undefined, status: FlowStatus, errorType?: string) =>
  FlowEvents.record({
    flow: 'routine_report',
    via: 'system',
    actor: 'routine',
    operationId: record.reportRequestId,
    parentOperation: record.operationId,
    ...(topic === undefined ? {} : { topic }),
    status,
    ...failure(errorType),
  })

/**
 * Why a firing is recorded as skipped rather than run: no plan, resident authority off, or today's budget spent. Any
 * other failure (auth D1, storage) fails the admission and is reported, so an outage never skips a firing.
 */
export const admissionSkip = Effect.gen(function* () {
  yield* requirePlan('routines')
  yield* requireResident
  yield* requireBudget
}).pipe(
  Effect.as(undefined),
  Effect.catchTags({ SubscriptionRequired: skipAs, ResidentInactive: skipAs, BudgetExhausted: skipAs }),
  reportFailure('routines.admit'),
)

/** Claims `firing` once by its operation id: admitted, or recorded skipped (`forcedSkip`, else what admission says). */
const claimFiring = (firing: Firing, forcedSkip: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* RoutineRuns
    const at = yield* Clock.currentTimeMillis
    const suffix = yield* nextInt
    const skip = forcedSkip ?? (yield* admissionSkip)
    const claim = yield* store.claim(firing, `rr_${at}_${Math.abs(suffix)}`, skip, at)
    yield* fireFlow(firing, claim.created ? (claim.run.state === 'skipped' ? 'refused' : 'ok') : 'replayed')
    return claim
  }).pipe(
    Effect.tapError((error) => fireFlow(firing, error instanceof Conflict ? 'refused' : 'error', safeErrorType(error))),
  )

/** The routines' next sweep (`routinesWake`) at `at` (epoch ms), unless one is due sooner. */
export const wakeAt = (at: number) =>
  Effect.gen(function* () {
    const { routineSchedules } = yield* AgentInput
    yield* attempt(() => routineSchedules.wake(at))
  })

/** The routines' next sweep `ms` from now. */
export const wakeIn = (ms: number) => Effect.flatMap(Clock.currentTimeMillis, (now) => wakeAt(now + ms))

/** A run's sealed event metadata, opened for its prompt; none for a run no event fired. */
const eventOf = (record: RoutineRun) =>
  Effect.gen(function* () {
    const sealed = record.eventDataSealed
    if (sealed === null) return undefined
    const cipher = yield* Cipher
    return yield* attempt(() => cipher.decrypt(sealed, `routine-event:${record.operationId}:${record.revision}`))
  })

/**
 * Hands a run to Pi: its deadline alarm first, then its own conversation under main (made once) and a reporter task
 * for this firing or this answer, on the owner's model or, for a run handed to a Persona, as that Persona at the
 * pinned revision (ADR 0041). Answers the session it runs in.
 */
export const startRun = Effect.fn('routines.start')(function* (record: RoutineRun, answer?: RoutineAnswer) {
  const { routineSchedules, startRoutine } = yield* AgentInput
  yield* attempt(() => routineSchedules.deadline(record.id, record.deadlineAt))
  const model = yield* Models.use((models) => models.current)
  const chats = yield* Chats
  const primary = yield* chats.session(chats.primary)
  const event = yield* eventOf(record)
  const persona = yield* runPersona(record)
  const pi = yield* PiSessions.use((sessions) => sessions.pi).pipe(Effect.catchTag('PiFailure', piFailure))
  const start = {
    primary,
    record,
    model,
    event,
    ...(persona === undefined ? {} : { persona }),
    ...(answer === undefined ? {} : { answer }),
  }
  const session = yield* attempt(() => startRoutine(pi, start))
  yield* wakeAt(record.deadlineAt)
  return session
})

/** Settles a live run as stopped with `reason`, then aborts its Pi work; a run that already ended stays as it ended. */
export const stopRun = Effect.fn('routines.stop')(function* (id: string, reason: string) {
  const runs = yield* RoutineRuns
  const record = yield* runs.get(id)
  yield* runs.settle(id, 'stopped', reason, yield* Clock.currentTimeMillis)
  const session = record.sessionId
  if (session !== null) {
    const conversation = yield* PiSessions.use((sessions) => sessions.conversation(session)).pipe(
      Effect.catchTag('PiFailure', piFailure),
    )
    if (Option.isSome(conversation)) yield* attempt(() => conversation.value.abort(BACKGROUND, { background: true }))
  }
  yield* wakeIn(1000)
})

/** A run's deadline alarm: the run stops once its deadline has passed. */
export const deadlineRun = Effect.fn('routines.deadline')(function* (id: string) {
  const record = yield* RoutineRuns.use((runs) => runs.get(id))
  if (record.deadlineAt <= (yield* Clock.currentTimeMillis)) yield* stopRun(id, DEADLINE_REACHED)
})

/** The owner archived `routineId`: its live runs stop. */
export const archiveRuns = Effect.fn('routines.archiveRuns')(function* (routineId: string) {
  const live = yield* RoutineRuns.use((runs) => runs.live)
  for (const record of live) if (record.routineId === routineId) yield* stopRun(record.id, 'Routine archived by owner')
})

/** The owner's answer in `session`: false when no routine run waits there; else the run takes it, once, and goes on. */
export const answerRun = Effect.fn('routines.answer')(function* (session: string, operationId: string, text: string) {
  const answerHash = yield* attempt(() => sha256Hex(text))
  const at = yield* Clock.currentTimeMillis
  const record = yield* RoutineRuns.use((runs) => runs.resume(session, operationId, at, answerHash))
  if (record === undefined) return false
  yield* startRun(record, { operationId, text })
  return true
})

/**
 * Admits `firing` once by its operation id and hands an admitted run to Pi; `forcedSkip` records it skipped instead.
 * A routine whose Persona is archived or changed since its pin records the firing skipped and pauses, with why as its
 * health, until the owner confirms it again (ADR 0041). Answers the run as stored after.
 */
export const admit = Effect.fn('routines.admit')(function* (firing: Firing, forcedSkip?: string) {
  const held = forcedSkip === undefined ? yield* personaHold(firing.routineId) : undefined
  const claimed = yield* claimFiring(firing, forcedSkip ?? held)
  if (held !== undefined)
    yield* (yield* Routines).halt(firing.routineId, firing.revision, held, yield* Clock.currentTimeMillis)
  if (claimed.run.state === 'admitted' || claimed.run.state === 'running') yield* startRun(claimed.run)
  yield* wakeIn(1000)
  return yield* RoutineRuns.use((runs) => runs.get(claimed.run.id))
})

/**
 * The owner's "run now" at a confirmed revision; the same operation finds the same run. A routine that hands nothing
 * over has nothing to run (ADR 0041).
 */
export const manualRun = Effect.fn('routines.manual')(function* (id: string, input: RoutineManualRun) {
  if (handOverOf(definitionOf(yield* (yield* Routines).get(id))) === undefined)
    return yield* new InvalidInput({ reason: 'nothing_to_run' })
  const firedAt = yield* Clock.currentTimeMillis
  return yield* admit({
    routineId: id,
    revision: input.revision,
    operationId: `routine-manual:${id}:${input.operationId}`,
    source: 'manual',
    firedAt,
  })
})

/**
 * The answer of a run handed to a Persona that completed: the Persona's words, attributed to it at the pinned revision
 * (ADR 0041). A run that failed, stopped or was skipped, or one handed to Goblin, reports as the routine instead.
 */
const personaAnswer = Effect.fn('routines.personaAnswer')(function* (record: RoutineRun) {
  if (record.state !== 'completed' || record.summary === null) return undefined
  const persona = yield* runPersona(record).pipe(Effect.catchTag('NotFound', () => Effect.succeed(undefined)))
  if (persona === undefined) return undefined
  const { id, name, revision, avatar } = persona
  return { text: record.summary, persona: { persona: id, name, revision, avatar } }
})

/** A run that ended reports into its Topic's Conversation once, frozen as it ended (ADR 0012). */
export const reportRun = (record: RoutineRun) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const store = yield* RoutineRuns
    const topic = yield* (yield* Routines).topicOf(record.routineId)
    const session = record.sessionId
    if (session !== null) yield* RoutineUsage.use((projection) => projection.snapshot(session))
    const answered = yield* personaAnswer(record)
    const text =
      answered !== undefined
        ? answered.text
        : record.summary === null
          ? 'Routine ended.'
          : `Routine ${record.outcome ?? record.state}: ${record.summary.slice(0, 500)}`
    yield* conversations.reportRoutine({
      runId: record.id,
      routineId: record.routineId,
      sessionId: record.sessionId,
      outcome: record.outcome ?? record.state,
      text,
      at: record.updatedAt,
      topic,
      ...(answered === undefined ? {} : { persona: answered.persona }),
    })
    // An answer the owner asked to be told about is a notification, except of a run they started themselves.
    if (record.source !== 'manual')
      yield* notifyReport({ id: record.routineId, topicId: topic }, definitionOf(record), {
        runId: record.id,
        text,
        at: record.updatedAt,
      })
    yield* store.reported(record.id, yield* Clock.currentTimeMillis)
    yield* reportFlow(record, topic, 'ok')
  }).pipe(Effect.tapError((error) => reportFlow(record, undefined, 'error', safeErrorType(error))))
