import type { QuestionSpec, RoutineDefinition, RoutineManualRun, RoutineRunView, RoutineView } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { CredentialCipher } from '../mcp/cipher.ts'
import type { EventContext } from '../mcp/events/dispatcher.ts'
import type { appRoutineSettings } from '../storage/routines.ts'
import type { Firing, RoutineRun } from './runs.ts'
import type { RoutineSlot } from './scheduler.ts'
import type { RoutineOperationResult, RoutineRow } from './store.ts'

/** The owner's routine caps and timezone, as stored (one row). */
type RoutineSettingsRow = typeof appRoutineSettings.$inferSelect
/** A cron or one-off slot that fired: which one was expected, the next one, and how many were missed between. */
type SlotAdvance = {
  readonly id: string
  readonly revision: number
  readonly expectedAt: number
  readonly nextAt: number | null
  readonly missed: number
}

/**
 * The owner's routines (ADR 0012): drafts, the revisions the owner confirmed, and their schedules. Every change takes
 * the revision it was made against and an operation id, and the same operation answers the same result again.
 * Instants are epoch milliseconds.
 */
export class Routines extends Context.Service<
  Routines,
  {
    /** Every routine, newest change first; archived ones only when asked. */
    readonly list: (includeArchived?: boolean) => Effect.Effect<RoutineView[]>
    /** The routine as stored; `NotFound` when this owner has none by that id. */
    readonly get: (id: string) => Effect.Effect<RoutineRow, AppError>
    readonly view: (id: string) => Effect.Effect<RoutineView, AppError>
    /** The Topic that owns the routine (ADR 0032), Personal for one this agent does not have. */
    readonly topicOf: (id: string) => Effect.Effect<number>
    readonly propose: (
      definition: RoutineDefinition,
      operationId: string,
      routineId: string,
      at: number,
      topic?: number,
    ) => Effect.Effect<RoutineOperationResult, AppError>
    readonly edit: (
      routineId: string,
      revision: number,
      definition: RoutineDefinition,
      operationId: string,
      at: number,
    ) => Effect.Effect<RoutineOperationResult, AppError>
    readonly confirm: (
      routineId: string,
      revision: number,
      operationId: string,
      at: number,
    ) => Effect.Effect<RoutineOperationResult, AppError>
    readonly pause: (
      routineId: string,
      revision: number,
      operationId: string,
      at: number,
    ) => Effect.Effect<RoutineOperationResult, AppError>
    readonly archive: (
      routineId: string,
      revision: number,
      operationId: string,
      at: number,
    ) => Effect.Effect<RoutineOperationResult, AppError>
    /** An activating or active revision is live: its native schedule, if it has one, is `scheduleId`. */
    readonly markActive: (
      routineId: string,
      revision: number,
      scheduleId: string | null,
      at: number,
    ) => Effect.Effect<RoutineView, AppError>
    readonly settings: Effect.Effect<RoutineSettingsRow>
    /** `InvalidInput` for an unknown timezone or caps outside 1–20 active and 1–2 running. */
    readonly updateSettings: (timezone: string, maxActive: number, maxRunning: number) => Effect.Effect<void, AppError>
    /** Every routine as stored, archived ones included: what the scheduler and the Events bindings reconcile. */
    readonly scheduling: Effect.Effect<RoutineRow[]>
    readonly eventHealth: (id: string, revision: number, health: string | null, at: number) => Effect.Effect<void>
    /** Moves an active routine past the slot that fired, unless something changed it since. */
    readonly advance: (input: SlotAdvance, at: number) => Effect.Effect<void, AppError>
    /** Holds a sealed firing that found the routine busy, to drain later. */
    readonly pending: (id: string, revision: number, sealed: string, at: number) => Effect.Effect<void>
    /** Holds a sealed firing and advances past its slot, in one transaction. */
    readonly queue: (input: SlotAdvance, sealed: string, at: number) => Effect.Effect<void, AppError>
    readonly clearPending: (id: string, sealed: string, at: number) => Effect.Effect<void, AppError>
  }
>()('goblin/routines/Routines') {}

/**
 * Each routine run's application metadata: its admission, its Pi session, its questions to the owner, its usage, its
 * report and its Telegram notification. Pi owns the run itself; no transaction here spans an await.
 */
export class RoutineRuns extends Context.Service<
  RoutineRuns,
  {
    /** Seals a run's `ask_user` questions and marks it waiting for the owner. */
    readonly ask: (
      session: string,
      callId: string,
      questions: readonly QuestionSpec[],
      cipher: CredentialCipher,
      at: number,
    ) => Effect.Effect<void, AppError>
    /** Takes the owner's answer to a waiting run once; the run to start again, if it is a routine run. */
    readonly resume: (
      session: string,
      operationId: string,
      at: number,
      answerHash: string,
    ) => Effect.Effect<RoutineRun | undefined, AppError>
    readonly get: (id: string) => Effect.Effect<RoutineRun, AppError>
    /** The run bound to Pi session `session`, if any. */
    readonly session: (session: string) => Effect.Effect<RoutineRun | undefined>
    /** A routine's newest 50 runs; `NotFound` when the owner has no such routine. */
    readonly list: (routineId: string) => Effect.Effect<RoutineRunView[], AppError>
    /** Runs admitted, running or waiting for the owner (at most 100). */
    readonly live: Effect.Effect<RoutineRun[]>
    readonly unfinishedReports: Effect.Effect<RoutineRun[]>
    /** Admits a firing once by its operation id, or records it skipped with `skip`. */
    readonly claim: (
      firing: Firing,
      id: string,
      skip: string | undefined,
      at: number,
    ) => Effect.Effect<{ readonly run: RoutineRun; readonly created: boolean }, AppError>
    readonly bind: (id: string, sessionId: string, at: number) => Effect.Effect<void, AppError>
    readonly settle: (
      id: string,
      state: 'completed' | 'failed' | 'stopped' | 'skipped',
      summary: string,
      at: number,
    ) => Effect.Effect<void, AppError>
    readonly reported: (id: string, at: number) => Effect.Effect<void>
    /** Reported runs whose Telegram notification is due. */
    readonly notifications: (at: number) => Effect.Effect<RoutineRun[]>
    readonly notification: (
      id: string,
      values: { state: string; serverId: string | null; receipt: string | null; nextAt: number; attempt: number },
    ) => Effect.Effect<void>
    /** Claims one notification attempt; false when another attempt holds it. */
    readonly claimNotification: (
      id: string,
      attempts: number,
      serverId: string | null,
      at: number,
    ) => Effect.Effect<boolean>
    /** Tokens the run and its routine's UTC day have used. */
    readonly used: (id: string, at: number) => Effect.Effect<{ readonly run: number; readonly day: number }, AppError>
    /** One committed usage delta, once by its key: tokens for the run's caps, Credits for the daily budget. */
    readonly recordUsage: (
      id: string,
      key: string,
      tokens: number,
      milliCredits: number,
      at: number,
    ) => Effect.Effect<void>
  }
>()('goblin/routines/RoutineRuns') {}

/** What routine runs spent, projected from Pi's committed usage (ADR 0026). */
export class RoutineUsage extends Context.Service<
  RoutineUsage,
  {
    /** Records what is new in a session's cumulative usage document since it was last projected. */
    readonly project: (session: string, value: unknown, at: number) => Effect.Effect<void, AppError>
    /** Projects the session's current usage document from Pi. */
    readonly snapshot: (session: string) => Effect.Effect<void, AppError>
  }
>()('goblin/routines/RoutineUsage') {}

/**
 * The routines' runtime: admission, the native schedules, Events bindings, and starting, answering and stopping runs.
 * Pi executes each run; this owns the handoffs to it.
 */
export class RoutineControl extends Context.Service<
  RoutineControl,
  {
    /** The owner's "run now" at a confirmed revision; the same operation finds the same run. */
    readonly manual: (id: string, input: RoutineManualRun) => Effect.Effect<RoutineRun, AppError>
    /** Repairs the native schedules and the Events subscriptions to match the stored routines. */
    readonly reconcile: Effect.Effect<void, AppError>
    /** Subscribes a confirmed event routine's revision. */
    readonly confirmEvents: (id: string, revision: number) => Effect.Effect<void, AppError>
    /** Stops the routine's live runs as archived by the owner. */
    readonly archive: (routineId: string) => Effect.Effect<void, AppError>
    readonly stop: (id: string, reason?: string) => Effect.Effect<void, AppError>
    /** The owner's answer to a waiting run's question; false when `session` is no routine run waiting for one. */
    readonly answer: (session: string, operationId: string, text: string) => Effect.Effect<boolean, AppError>
    /** A run reached its deadline alarm. */
    readonly deadline: (id: string) => Effect.Effect<void, AppError>
    /** A native schedule's slot is due. */
    readonly fire: (slot: RoutineSlot) => Effect.Effect<void, AppError>
    /** The routines' sweep: deadlines, admitted starts, reports, notifications, then reconciliation. */
    readonly maintain: Effect.Effect<void, AppError>
    /** An Events delivery for a routine's subscription. */
    readonly consumeEvent: (context: EventContext) => Effect.Effect<void, AppError>
  }
>()('goblin/routines/RoutineControl') {}
