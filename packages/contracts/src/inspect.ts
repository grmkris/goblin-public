import * as Schema from 'effect/Schema'
import { ConversationView } from './index.ts'
import { RunEvent, RunEventStatus } from './telemetry.ts'

/**
 * Read-only inspection of one agent (ADR 0024): its conversations, a conversation's entries, its turns and their
 * timelines, and what went wrong. Full content for conversations, bounded and paged; no reads call a model.
 */
const Session = Schema.String.check(Schema.isPattern(/^\d{1,12}$/u))
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
/** Epoch milliseconds. */
const Since = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const InspectQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('conversations') }),
  Schema.Struct({
    kind: Schema.Literal('conversation'),
    conversation: Session,
    /** Entries before this entry id; the newest page without it. */
    before: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    kind: Schema.Literal('turns'),
    conversation: Schema.optional(Session),
    since: Schema.optional(Since),
    limit: Schema.optional(Limit),
  }),
  Schema.Struct({ kind: Schema.Literal('turn'), operationId: Schema.String.check(Schema.isMaxLength(200)) }),
  Schema.Struct({ kind: Schema.Literal('problems'), since: Schema.optional(Since), limit: Schema.optional(Limit) }),
])
export type InspectQuery = typeof InspectQuery.Type

export const InspectConversations = Schema.Struct({ conversations: Schema.Array(ConversationView) })
export type InspectConversations = typeof InspectConversations.Type

/** One Pi entry as a reader needs it. Long text is cut (`truncated`); nothing is summarized or rewritten. */
export const InspectEntry = Schema.Struct({
  id: Schema.Number,
  kind: Schema.String,
  role: Schema.optional(Schema.String),
  /** Who wrote a user message, when it was not the owner in the app (an MCP client, Telegram). */
  author: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  /** The calls an answer made, with their arguments as JSON. */
  toolCalls: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, arguments: Schema.String })),
  ),
  /** For a tool result: which call it answers and whether it failed. */
  tool: Schema.optional(Schema.Struct({ callId: Schema.String, name: Schema.String, isError: Schema.Boolean })),
  /** For an answer: the model, why it stopped, its error and tokens. */
  model: Schema.optional(
    Schema.Struct({
      provider: Schema.String,
      model: Schema.String,
      stopReason: Schema.String,
      error: Schema.optional(Schema.String),
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cacheReadTokens: Schema.Number,
    }),
  ),
  /** Pi's own JSON for entries without messages (`app.*`, compaction), as text. */
  data: Schema.optional(Schema.String),
  /** When the message was made, epoch ms. */
  at: Schema.optional(Schema.Number),
  /** The Pi task that wrote it: joins the turn's run events. */
  task: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
})
export type InspectEntry = typeof InspectEntry.Type

/** A page of a conversation's entries, oldest first; `before` asks for the page before it. */
export const InspectEntries = Schema.Struct({
  conversation: Schema.String,
  entries: Schema.Array(InspectEntry),
  before: Schema.optional(Schema.Number),
})
export type InspectEntries = typeof InspectEntries.Type

/** One turn in a line: where it came from, how it ended, what it took. */
export const TurnSummary = Schema.Struct({
  operationId: Schema.String,
  conversationId: Schema.optional(Schema.String),
  source: Schema.String,
  status: RunEventStatus,
  reason: Schema.optional(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
  modelAttempts: Schema.Number,
  failedAttempts: Schema.Number,
  toolCalls: Schema.Number,
  failedToolCalls: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
})
export type TurnSummary = typeof TurnSummary.Type

export const InspectTurns = Schema.Struct({ turns: Schema.Array(TurnSummary) })
export type InspectTurns = typeof InspectTurns.Type

/** What a timeline could not show, so a reader never mistakes a gap for nothing having happened. */
export const Coverage = Schema.Struct({ complete: Schema.Boolean, gaps: Schema.Array(Schema.String) })

/**
 * One turn end to end: Pi's own settlement of the submission, every run event of it in order, and the entries it
 * spans (read them with a `conversation` query, `before` the answer).
 */
export const TurnTimeline = Schema.Struct({
  turn: TurnSummary,
  submission: Schema.optional(
    Schema.Struct({
      status: Schema.String,
      entry: Schema.optional(Schema.Number),
      answer: Schema.optional(Schema.Number),
      reason: Schema.optional(Schema.String),
    }),
  ),
  events: Schema.Array(RunEvent),
  coverage: Coverage,
})
export type TurnTimeline = typeof TurnTimeline.Type

/** What went wrong since `since`, newest first: failed, blocked and interrupted events, unanswered turns among them. */
export const InspectProblems = Schema.Struct({ since: Schema.Number, problems: Schema.Array(RunEvent) })
export type InspectProblems = typeof InspectProblems.Type
