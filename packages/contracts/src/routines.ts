import * as Schema from 'effect/Schema'
import { NonEmptyString, OperationId, TopicId } from './ids.ts'

const positive = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }))
const server = NonEmptyString(64).check(Schema.isPattern(/^[\w-]+$/u))

export const RoutineTrigger = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('once'), at: NonEmptyString(64) }),
  Schema.Struct({ kind: Schema.Literal('cron'), expression: NonEmptyString(120) }),
  Schema.Struct({
    kind: Schema.Literal('event'),
    connectionId: server,
    name: NonEmptyString(256),
    arguments: Schema.Record(Schema.String, Schema.Json),
  }),
])
/** The limits of one hand-over: tokens per run and per day, and how long a run may take. */
export const RoutineBudget = Schema.Struct({
  tokensPerRun: positive(100_000),
  tokensPerDay: positive(2_000_000),
  runtimeSeconds: positive(1800),
})
export type RoutineBudget = typeof RoutineBudget.Type

/** What a hand-over carries (ADR 0041): the owner's instruction, the tools the work may call, and its limits. */
const HandOver = {
  instruction: NonEmptyString(12_000),
  allowedTools: Schema.Array(Schema.Struct({ connectionId: server, name: NonEmptyString(256) })).check(
    Schema.isMaxLength(100),
  ),
  budget: RoutineBudget,
}

/** Who a routine gives its work to (ADR 0041): nobody (it only tells the owner), or Goblin. */
export const RoutineHandTo = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('none') }),
  Schema.Struct({ kind: Schema.Literal('goblin'), ...HandOver }),
])
export type RoutineHandTo = typeof RoutineHandTo.Type
/** A hand-over: the routine gives its work to someone, with an instruction, tools and limits. */
export type RoutineHandOver = Exclude<RoutineHandTo, { readonly kind: 'none' }>

/** Whether the owner is told of what the routine posts (ADR 0041), and on Telegram too; Telegram needs Tell me. */
export const RoutineTellMe = Schema.Struct({ on: Schema.Boolean, telegram: Schema.Boolean }).check(
  Schema.makeFilter((tellMe) => !tellMe.telegram || tellMe.on || 'Telegram needs Tell me on.'),
)
export type RoutineTellMe = typeof RoutineTellMe.Type

/**
 * What the owner confirmed to happen on a trigger (ADR 0041): tell them, hand the work over, or both. A routine that
 * hands nothing over must tell them, or it would do nothing.
 */
export const RoutineDefinition = Schema.Struct({
  title: NonEmptyString(120),
  trigger: RoutineTrigger,
  timezone: NonEmptyString(80),
  tellMe: RoutineTellMe,
  handTo: RoutineHandTo,
}).check(
  Schema.makeFilter(
    (definition) =>
      definition.handTo.kind !== 'none' || definition.tellMe.on || 'A routine that hands nothing over must tell you.',
  ),
)
export type RoutineDefinition = typeof RoutineDefinition.Type

/** The hand-over of `definition`, when it gives its work to someone. */
export const handOverOf = (definition: RoutineDefinition): RoutineHandOver | undefined =>
  definition.handTo.kind === 'none' ? undefined : definition.handTo

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
  outsideSetup: Schema.optional(Schema.Array(Schema.Struct({ connectionId: Schema.String, name: Schema.String }))),
})
export type RoutineView = typeof RoutineView.Type
export const RoutinePage = Schema.Struct({
  routines: Schema.Array(RoutineView),
  nextCursor: Schema.optional(Schema.String),
})
export type RoutinePage = typeof RoutinePage.Type
/** A routine the owner proposes, in the Topic they name: it lives, runs and posts there. */
export const RoutineProposal = Schema.Struct({
  operationId: OperationId,
  topic: TopicId,
  definition: RoutineDefinition,
})
export type RoutineProposal = typeof RoutineProposal.Type
export const RoutineRevision = Schema.Struct({ revision: positive(1_000_000), operationId: OperationId })
export type RoutineRevision = typeof RoutineRevision.Type
export const RoutineEdit = Schema.Struct({ ...RoutineRevision.fields, topic: TopicId, definition: RoutineDefinition })
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
