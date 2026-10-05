import type { PiHarness } from 'agents/harness/pi'
import type { RoutineManualRun } from '@purrable/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { nextInt } from 'effect/Random'
import { Entitlements } from '../billing/gates.ts'
import {
  Conversations,
  Models,
  RoutineRuns,
  RoutineUsageProjection,
  attempt,
  attemptSync,
  requireBudget,
  requireResident,
} from '../services.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
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
        const skip =
          forcedSkip ??
          (yield* Effect.gen(function* () {
            yield* Entitlements.use((plans) => plans.require('routines'))
            yield* requireResident
            yield* requireBudget
          }).pipe(
            Effect.as(undefined),
            Effect.catch((error) => Effect.succeed(error._tag)),
          ))
        return yield* attemptSync(() => store.claim(firing, `rr_${at}_${Math.abs(suffix)}`, skip, at))
      }),
    )
    if (claimed.run.state === 'admitted' || claimed.run.state === 'running') await this.start(claimed.run)
    await this.#wake(Date.now() + 1000)
    return this.#run(RoutineRuns.useSync((store) => store.get(claimed.run.id)))
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
    const model = await this.#run(Models.useSync((models) => models.current()))
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
        return yield* attemptSync(() => store.resume(session, operationId, at, answerHash))
      }),
    )
    if (record === undefined) return false
    await this.start(record, { operationId, text })
    return true
  }

  async stop(id: string, reason = 'Stopped by owner'): Promise<void> {
    const record = await this.#run(RoutineRuns.use((store) => attemptSync(() => store.get(id))))
    await this.#run(
      Effect.gen(function* () {
        const store = yield* RoutineRuns
        const at = yield* Clock.currentTimeMillis
        yield* attemptSync(() => store.settle(id, 'stopped', reason, at))
      }),
    )
    if (record.sessionId !== null) {
      const conversation = await (await this.#harness.pi()).conversation(conversationId(record.sessionId), BACKGROUND)
      await conversation?.abort(BACKGROUND, { background: true })
    }
    await this.#wake(Date.now() + 1000)
  }
  async deadline(id: string): Promise<void> {
    const run = await this.#run(RoutineRuns.use((store) => attemptSync(() => store.get(id))))
    if (run.deadlineAt <= Date.now()) await this.stop(id, 'Absolute routine deadline reached')
  }
  async archive(routineId: string): Promise<void> {
    const runs = await this.#run(
      RoutineRuns.useSync((store) => store.live().filter((record) => record.routineId === routineId)),
    )
    for (const record of runs) await this.stop(record.id, 'Routine archived by owner')
  }

  async maintain(): Promise<void> {
    const live = await this.#run(RoutineRuns.useSync((store) => store.live()))
    for (const record of live) {
      if (record.deadlineAt <= Date.now()) await this.stop(record.id, 'Absolute routine deadline reached')
      else if (record.state === 'admitted') await this.start(record)
    }
    const reports = await this.#run(RoutineRuns.useSync((store) => store.unfinishedReports()))
    for (const record of reports) await this.report(record)
    const notifications = await this.#run(RoutineRuns.useSync((store) => store.notifications(Date.now())))
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
        const session = record.sessionId
        if (session !== null)
          yield* RoutineUsageProjection.use((projection) => attempt(() => projection.snapshot(session)))
        yield* attempt(() =>
          conversations.reportRoutine({
            runId: record.id,
            routineId: record.routineId,
            sessionId: record.sessionId,
            outcome: record.outcome ?? record.state,
            text: record.notificationText ?? 'Routine ended.',
            at: record.updatedAt,
          }),
        )
        const at = yield* Clock.currentTimeMillis
        yield* attemptSync(() => store.reported(record.id, at))
      }),
    )
  }
}
