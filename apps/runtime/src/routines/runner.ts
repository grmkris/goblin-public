import type { PiHarness } from 'agents/harness/pi'
import type { RoutineManualRun } from '@goblin/contracts'
import type { FlowStatus, FlowVia } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { nextInt } from 'effect/Random'
import { requirePlan } from '../billing/gates.ts'
import { requireBudget } from '../budget.ts'
import { Conversations } from '../chats/service.ts'
import { requireResident } from '../mcp/service.ts'
import { Models } from '../models.ts'
import { FlowEvents } from '../observability/flows.ts'
import { reportFailure, safeErrorType } from '../observability/report.ts'
import { Conflict } from '../http/errors.ts'
import { RoutineRuns, RoutineUsage, Routines } from './service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { type Firing, type RoutineRun } from './runs.ts'
import { notifyRoutine } from './notifications.ts'

export type StartRun = (
  harness: PiHarness,
  record: RoutineRun,
  model: string,
  answer?: { operationId: string; text: string },
) => Promise<string>
export type RoutineWake = (at: number) => Promise<void>

const skipAs = (error: { readonly _tag: string }) => Effect.succeed(error._tag)

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
  FlowEvents.use((flows) =>
    flows.record({
      flow: 'routine_fire',
      via: VIA[firing.source],
      actor: firing.source === 'manual' ? 'owner' : 'routine',
      operationId: firing.operationId,
      status,
      ...failure(errorType),
    }),
  )

/** A run's frozen report into its Topic's Conversation as a flow, under the run's operation. */
const reportFlow = (record: RoutineRun, topic: number | undefined, status: FlowStatus, errorType?: string) =>
  FlowEvents.use((flows) =>
    flows.record({
      flow: 'routine_report',
      via: 'system',
      actor: 'routine',
      operationId: record.reportRequestId,
      parentOperation: record.operationId,
      ...(topic === undefined ? {} : { topic }),
      status,
      ...failure(errorType),
    }),
  )

/**
 * Why a firing is recorded as skipped rather than run: no plan, resident authority off, or today's budget spent. Any
 * other failure (auth D1, storage) fails the admission and is reported, so an outage never skips a firing (R3).
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

/** Pi owns execution; this coordinator only repairs the app-to-Pi handoffs and frozen passive reports. */
export class RoutineRunner {
  readonly #run: RunProgram
  readonly #harness: PiHarness
  readonly #start: StartRun
  readonly #wake: RoutineWake
  constructor(run: RunProgram, harness: PiHarness, start: StartRun, wake: RoutineWake) {
    this.#run = run
    this.#harness = harness
    this.#start = start
    this.#wake = wake
  }

  async admit(firing: Firing, forcedSkip?: string): Promise<RoutineRun> {
    const claimed = await this.#run(
      Effect.gen(function* () {
        const store = yield* RoutineRuns
        const at = yield* Clock.currentTimeMillis
        const suffix = yield* nextInt
        const skip = forcedSkip ?? (yield* admissionSkip)
        const claim = yield* store.claim(firing, `rr_${at}_${Math.abs(suffix)}`, skip, at)
        yield* fireFlow(firing, claim.created ? (claim.run.state === 'skipped' ? 'refused' : 'ok') : 'replayed')
        return claim
      }).pipe(
        Effect.tapError((error) =>
          fireFlow(firing, error instanceof Conflict ? 'refused' : 'error', safeErrorType(error)),
        ),
      ),
    )
    if (claimed.run.state === 'admitted' || claimed.run.state === 'running') await this.start(claimed.run)
    await this.#wake(Date.now() + 1000)
    return this.#run(RoutineRuns.use((store) => store.get(claimed.run.id)))
  }

  manual(id: string, input: RoutineManualRun): Promise<RoutineRun> {
    return this.admit({
      routineId: id,
      revision: input.revision,
      operationId: `routine-manual:${id}:${input.operationId}`,
      source: 'manual',
      firedAt: Date.now(),
    })
  }

  async start(record: RoutineRun, answer?: { operationId: string; text: string }): Promise<string> {
    const model = await this.#run(Models.use((models) => models.current))
    const session = await this.#start(this.#harness, record, model, answer)
    await this.#wake(record.deadlineAt)
    return session
  }

  async answer(session: string, operationId: string, text: string): Promise<boolean> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
    const answerHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
    const record = await this.#run(
      Effect.gen(function* () {
        const store = yield* RoutineRuns
        const at = yield* Clock.currentTimeMillis
        return yield* store.resume(session, operationId, at, answerHash)
      }),
    )
    if (record === undefined) return false
    await this.start(record, { operationId, text })
    return true
  }

  async stop(id: string, reason = 'Stopped by owner'): Promise<void> {
    const record = await this.#run(RoutineRuns.use((store) => store.get(id)))
    await this.#run(
      Effect.gen(function* () {
        const store = yield* RoutineRuns
        const at = yield* Clock.currentTimeMillis
        yield* store.settle(id, 'stopped', reason, at)
      }),
    )
    if (record.sessionId !== null) {
      const conversation = await (await this.#harness.pi()).conversation(conversationId(record.sessionId), BACKGROUND)
      await conversation?.abort(BACKGROUND, { background: true })
    }
    await this.#wake(Date.now() + 1000)
  }
  async deadline(id: string): Promise<void> {
    const run = await this.#run(RoutineRuns.use((store) => store.get(id)))
    if (run.deadlineAt <= Date.now()) await this.stop(id, 'Absolute routine deadline reached')
  }
  async archive(routineId: string): Promise<void> {
    const runs = await this.#run(
      RoutineRuns.use((store) =>
        Effect.map(store.live, (live) => live.filter((record) => record.routineId === routineId)),
      ),
    )
    for (const record of runs) await this.stop(record.id, 'Routine archived by owner')
  }

  async maintain(): Promise<void> {
    const live = await this.#run(RoutineRuns.use((store) => store.live))
    for (const record of live) {
      if (record.deadlineAt <= Date.now()) await this.stop(record.id, 'Absolute routine deadline reached')
      else if (record.state === 'admitted') await this.start(record)
    }
    const reports = await this.#run(RoutineRuns.use((store) => store.unfinishedReports))
    for (const record of reports) await this.report(record)
    const notifications = await this.#run(RoutineRuns.use((store) => store.notifications(Date.now())))
    for (const record of notifications) await this.#run(notifyRoutine(record))
    if (notifications.length > 0) await this.#wake(Date.now() + 30_000)
    const next = live.filter((record) => record.deadlineAt > Date.now()).map((record) => record.deadlineAt)
    if (next.length > 0 || reports.length === 100) await this.#wake(Math.min(Date.now() + 60_000, ...next))
  }

  async report(record: RoutineRun): Promise<void> {
    await this.#run(
      Effect.gen(function* () {
        const conversations = yield* Conversations
        const store = yield* RoutineRuns
        const topic = yield* (yield* Routines).topicOf(record.routineId)
        const session = record.sessionId
        if (session !== null) yield* RoutineUsage.use((projection) => projection.snapshot(session))
        yield* conversations.reportRoutine({
          runId: record.id,
          routineId: record.routineId,
          sessionId: record.sessionId,
          outcome: record.outcome ?? record.state,
          text: record.notificationText ?? 'Routine ended.',
          at: record.updatedAt,
          topic,
        })
        const at = yield* Clock.currentTimeMillis
        yield* store.reported(record.id, at)
        yield* reportFlow(record, topic, 'ok')
      }).pipe(Effect.tapError((error) => reportFlow(record, undefined, 'error', safeErrorType(error)))),
    )
  }
}
