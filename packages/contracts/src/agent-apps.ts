import * as Schema from 'effect/Schema'

/**
 * One schedule of an agent app (ADR 0021): the action it runs, how often (a daily one at `at`, UTC), when next, how
 * the last run went, its failures in a row, and whether it is paused (by the owner, or by failures until a new
 * release).
 */
export const AgentAppJob = Schema.Struct({
  action: Schema.String,
  every: Schema.Literals(['15m', '30m', '1h', '3h', '6h', '12h', '1d']),
  at: Schema.NullOr(Schema.String),
  nextAt: Schema.Number,
  lastAt: Schema.NullOr(Schema.Number),
  status: Schema.NullOr(Schema.Literals(['ok', 'failed', 'waiting', 'skipped'])),
  /** Why the last run failed or waited. */
  error: Schema.NullOr(Schema.String),
  failures: Schema.Number,
  paused: Schema.NullOr(Schema.Literals(['owner', 'failures'])),
})
export type AgentAppJob = typeof AgentAppJob.Type

/** A power an agent app asks for (ADR 0021): a host to fetch from, an MCP tool, another app, model calls, Telegram. */
export const AppPowerKind = Schema.Literals(['egress', 'tool', 'app', 'llm', 'notify'])
export const AppPower = Schema.Struct({
  kind: AppPowerKind,
  target: Schema.String.check(Schema.isMaxLength(260)),
  status: Schema.Literals(['pending', 'approved', 'revoked']),
})
export type AppPower = typeof AppPower.Type

/** The owner approves (`allowed`) or revokes one power an agent app asks for. */
export const AppPowerChange = Schema.Struct({
  kind: AppPowerKind,
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(260)),
  allowed: Schema.Boolean,
})
export type AppPowerChange = typeof AppPowerChange.Type

/** An agent app as the owner's Apps page lists it (ADR 0021): what it is, where it lives and whether it needs them. */
export const AgentAppSummary = Schema.Struct({
  name: Schema.String,
  title: Schema.String,
  description: Schema.String,
  /** Its home conversation, where its builds and notes go. */
  home: Schema.String,
  /** Its App id once it has a view (what opens it), otherwise null. */
  app: Schema.NullOr(Schema.String),
  version: Schema.Number,
  revision: Schema.Number,
  jobs: Schema.Array(AgentAppJob),
  /** How many powers it asks for that the owner has not allowed. */
  waiting: Schema.Number,
  /** Its newest event when that is a failure, otherwise null. */
  failure: Schema.NullOr(Schema.String),
  updatedAt: Schema.Number,
})
export type AgentAppSummary = typeof AgentAppSummary.Type

/** One agent app in full on its page: its versions, powers, today's usage, its files and what happened lately. */
export const AgentAppDetail = Schema.Struct({
  ...AgentAppSummary.fields,
  releases: Schema.Array(
    Schema.Struct({
      release: Schema.String,
      version: Schema.Number,
      status: Schema.Literals(['active', 'retired', 'failed']),
      note: Schema.NullOr(Schema.String),
      at: Schema.Number,
    }),
  ),
  powers: Schema.Array(AppPower),
  usage: Schema.Struct({ egress: Schema.Number, tokens: Schema.Number, notify: Schema.Number, job: Schema.Number }),
  files: Schema.Struct({ count: Schema.Number, bytes: Schema.Number }),
  events: Schema.Array(Schema.Struct({ kind: Schema.String, detail: Schema.String, at: Schema.Number })),
})
export type AgentAppDetail = typeof AgentAppDetail.Type

const AppAction = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

/**
 * What the owner changes about an agent app: go back to an earlier version, pause or resume a schedule, run one now,
 * move its home to another conversation, or allow or revoke a power it asks for.
 */
export const AgentAppChange = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('rollback'), release: Schema.String.check(Schema.isMaxLength(40)) }),
  Schema.Struct({ kind: Schema.Literal('pause'), action: AppAction, paused: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal('run'), action: AppAction }),
  Schema.Struct({ kind: Schema.Literal('home'), conversation: Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)) }),
  Schema.Struct({
    kind: Schema.Literal('power'),
    power: AppPowerKind,
    target: AppPowerChange.fields.target,
    allowed: Schema.Boolean,
  }),
])
export type AgentAppChange = typeof AgentAppChange.Type

/** Deleting an agent app erases it; the owner confirms by typing its name. */
export const DeleteAgentApp = Schema.Struct({ confirm: Schema.String.check(Schema.isMaxLength(40)) })
export type DeleteAgentApp = typeof DeleteAgentApp.Type

/** The agent app the owner deleted, by name. */
export const AgentAppDeleted = Schema.Struct({ deleted: Schema.String })
export type AgentAppDeleted = typeof AgentAppDeleted.Type
