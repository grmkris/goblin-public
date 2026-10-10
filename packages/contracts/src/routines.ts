import * as Schema from 'effect/Schema'
import { NonEmptyString, OperationId } from './ids.ts'

const positive = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }))
const server = NonEmptyString(64).check(Schema.isPattern(/^[\w-]+$/u))

export const RoutineTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('once'), at: NonEmptyString(64) }),
  Schema.Struct({ kind: Schema.Literal('cron'), expression: NonEmptyString(120) }),
  Schema.Struct({
    kind: Schema.Literal('event'),
    serverId: server,
    name: NonEmptyString(256),
    arguments: Schema.Record(Schema.String, Schema.Json),
  }),
])
export const RoutineDefinition = Schema.Struct({
  title: NonEmptyString(120),
  prompt: NonEmptyString(12_000),
  trigger: RoutineTrigger,
  timezone: NonEmptyString(80),
  notifyTelegram: Schema.Boolean,
  allowedTools: Schema.Array(Schema.Struct({ serverId: server, name: NonEmptyString(256) })).check(
    Schema.isMaxLength(100),
  ),
  budget: Schema.Struct({
    tokensPerRun: positive(100_000),
    tokensPerDay: positive(2_000_000),
    runtimeSeconds: positive(1800),
  }),
})
export type RoutineDefinition = typeof RoutineDefinition.Type

export const RoutineView = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  state: Schema.Literals(['proposed', 'activating', 'active', 'paused', 'completed', 'archived']),
  definition: RoutineDefinition,
  confirmedAt: Schema.NullOr(Schema.Number),
  nextFireAt: Schema.NullOr(Schema.Number),
  lastFireAt: Schema.NullOr(Schema.Number),
  missedCount: Schema.Int,
  suppressedCount: Schema.Int,
  health: Schema.NullOr(Schema.String),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  /** The Topic the routine lives in (ADR 0040). */
  topic: Schema.optional(Schema.Int),
  /** Its allowed tools that its Topic's setup does not hold now: a run that calls one is refused. */
  outsideSetup: Schema.optional(Schema.Array(Schema.Struct({ serverId: Schema.String, name: Schema.String }))),
})
export type RoutineView = typeof RoutineView.Type
export const RoutinePage = Schema.Struct({
  routines: Schema.Array(RoutineView),
  nextCursor: Schema.optional(Schema.String),
})
export type RoutinePage = typeof RoutinePage.Type
export const RoutineProposal = Schema.Struct({ operationId: OperationId, definition: RoutineDefinition })
export type RoutineProposal = typeof RoutineProposal.Type
export const RoutineRevision = Schema.Struct({ revision: positive(1_000_000), operationId: OperationId })
export type RoutineRevision = typeof RoutineRevision.Type
export const RoutineEdit = Schema.Struct({ ...RoutineRevision.fields, definition: RoutineDefinition })
export type RoutineEdit = typeof RoutineEdit.Type
export const RoutineManualRun = Schema.Struct({ ...RoutineRevision.fields, confirmRun: Schema.Literal(true) })
export type RoutineManualRun = typeof RoutineManualRun.Type

export const RoutineRunView = Schema.Struct({
  id: Schema.String,
  routineId: Schema.String,
  revision: Schema.Int,
  source: Schema.Literals(['manual', 'once', 'cron', 'event']),
  firedAt: Schema.Number,
  sessionId: Schema.NullOr(Schema.String),
  state: Schema.Literals(['admitted', 'running', 'waiting_owner', 'completed', 'skipped', 'failed', 'stopped']),
  outcome: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  reportAcceptedAt: Schema.NullOr(Schema.Number),
  notificationState: Schema.String,
})
export type RoutineRunView = typeof RoutineRunView.Type
export const RoutineRunPage = Schema.Struct({
  runs: Schema.Array(RoutineRunView),
  nextCursor: Schema.optional(Schema.String),
})
export type RoutineRunPage = typeof RoutineRunPage.Type
export const RoutineSettings = Schema.Struct({
  timezone: NonEmptyString(80),
  maxActive: Schema.Int,
  maxRunning: Schema.Int,
})
export type RoutineSettings = typeof RoutineSettings.Type
