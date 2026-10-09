import * as Schema from 'effect/Schema'
import { ChatId, EntryId, OperationId } from './ids.ts'
import { ConversationView } from './index.ts'
import { FlowEvent, FlowName, RunEvent, RunEventStatus } from './telemetry.ts'

/**
 * Read-only inspection of one agent (ADR 0024): its conversations, a conversation's entries, its turns and their
 * timelines, what went wrong, its conversation flows and the details behind a message. Full content for conversations,
 * bounded and paged; no reads call a model.
 */
const Session = Schema.String.check(Schema.isPattern(/^\d{1,12}$/u)).annotate({
  description: 'A conversation id as `inspect_conversations` lists it; "1" is the main conversation.',
})
const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })).annotate({
  description: 'At most this many, 1 to 100.',
})
const Since = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
  description: 'Only what started since this time, in epoch milliseconds. Without it, the last day.',
})

/** `inspect_flows`' input: recent conversation flows, optionally of one chat or one flow. */
export const InspectFlowsInput = Schema.Struct({
  since: Schema.optional(Since),
  limit: Schema.optional(Limit),
  chat: Schema.optional(ChatId.annotate({ description: 'Only the flows of this chat (its id in /c/<id> URLs).' })),
  flow: Schema.optional(FlowName.annotate({ description: 'Only the steps of this flow (`reply`, `move`, …).' })),
})
export type InspectFlowsInput = typeof InspectFlowsInput.Type

/** What the details reader takes: one operation, or the operation that wrote an entry of a chat. */
export const InspectDetailsInput = Schema.Union([
  Schema.Struct({ operation: OperationId }),
  Schema.Struct({ chat: ChatId, entry: EntryId }),
])
export type InspectDetailsInput = typeof InspectDetailsInput.Type

/**
 * `inspect_details`' input as one flat object, because a tool's input schema is an object: `operation`, or `chat` with
 * `entry`. The reader takes it as {@link InspectDetailsInput} and refuses any other combination.
 */
const DetailsArguments = Schema.Struct({
  operation: Schema.optional(
    OperationId.annotate({
      description: 'An operation id, from `inspect_turns`, `inspect_problems` or `inspect_flows`.',
    }),
  ),
  chat: Schema.optional(
    ChatId.annotate({ description: 'With `entry`: the chat the entry is in (its id in /c/<id> URLs).' }),
  ),
  entry: Schema.optional(
    EntryId.annotate({
      description: 'With `chat`: an entry id; the details are those of the operation that wrote it.',
    }),
  ),
})
export type InspectDetailsArguments = typeof DetailsArguments.Type

/** What each query takes apart from its kind: the inputs of the inspection tools. */
export const InspectInput = {
  conversations: Schema.Struct({}),
  conversation: Schema.Struct({
    conversation: Session,
    before: Schema.optional(
      Schema.Int.check(Schema.isGreaterThan(0)).annotate({
        description: 'Entries before this entry id, from the last page; the newest page without it.',
      }),
    ),
  }),
  turns: Schema.Struct({
    conversation: Schema.optional(Session),
    since: Schema.optional(Since),
    limit: Schema.optional(Limit),
  }),
  turn: Schema.Struct({
    operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
      description: "The turn's operation id, from `inspect_turns` or `inspect_problems`.",
    }),
  }),
  problems: Schema.Struct({
    since: Schema.optional(Since),
    limit: Schema.optional(Limit),
    all: Schema.optional(Schema.Boolean).annotate({
      description: 'Include expected waits and confirmed recovered attempts; default shows events needing attention.',
    }),
  }),
  flows: InspectFlowsInput,
  details: DetailsArguments,
}
export type InspectKind = keyof typeof InspectInput

export const InspectQuery = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('conversations'), ...InspectInput.conversations.fields }),
  Schema.Struct({ kind: Schema.Literal('conversation'), ...InspectInput.conversation.fields }),
  Schema.Struct({ kind: Schema.Literal('turns'), ...InspectInput.turns.fields }),
  Schema.Struct({ kind: Schema.Literal('turn'), ...InspectInput.turn.fields }),
  Schema.Struct({ kind: Schema.Literal('problems'), ...InspectInput.problems.fields }),
  Schema.Struct({ kind: Schema.Literal('flows'), ...InspectInput.flows.fields }),
  Schema.Struct({ kind: Schema.Literal('details'), ...InspectInput.details.fields }),
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
  /** An answer's visible thinking, before its text and calls (redacted thinking is left out). */
  thinking: Schema.optional(Schema.String),
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
  /** Its `error` events; a reader older than the field sees none. */
  errors: Schema.optional(Schema.Number),
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

/** Events needing attention since `since`, newest first; `all` includes expected waits and recovered attempts. */
export const InspectProblems = Schema.Struct({ since: Schema.Number, problems: Schema.Array(RunEvent) })
export type InspectProblems = typeof InspectProblems.Type

/** One recorded flow event and when it was recorded (epoch ms). */
export const FlowRecord = Schema.Struct({ ...FlowEvent.fields, at: Schema.Number })
export type FlowRecord = typeof FlowRecord.Type

/** Flow events since `since`, newest first. */
export const InspectFlows = Schema.Struct({ since: Schema.Number, flows: Schema.Array(FlowRecord) })
export type InspectFlows = typeof InspectFlows.Type

/** An operation linked to the one in view: its parent, the thread it started, the Personas it asked. */
export const RelatedOperation = Schema.Struct({
  operation: OperationId,
  kind: Schema.String.check(Schema.isMaxLength(80)),
  chat: Schema.optional(ChatId),
  state: Schema.optional(Schema.String.check(Schema.isMaxLength(40))),
})
export type RelatedOperation = typeof RelatedOperation.Type

/**
 * A message's details: the timeline of the operation behind it (a passive write has no turn, so `turn` is optional)
 * and the operations related to it.
 */
export const InspectDetails = Schema.Struct({
  ...TurnTimeline.fields,
  turn: Schema.optional(TurnSummary),
  related: Schema.Array(RelatedOperation),
})
export type InspectDetails = typeof InspectDetails.Type

/** What each query answers. */
export const InspectResult = {
  conversations: InspectConversations,
  conversation: InspectEntries,
  turns: InspectTurns,
  turn: TurnTimeline,
  problems: InspectProblems,
  flows: InspectFlows,
  details: InspectDetails,
}
