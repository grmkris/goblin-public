import * as Schema from 'effect/Schema'
import { ComposerSelections } from './composer.ts'
import { FilePath } from './files.ts'
import { AppId, ChatId, EntryId, NonEmptyString, OperationId, TopicId } from './ids.ts'
import { Attention } from './threads.ts'

/** Stable primary chat id for URLs and application metadata; its current Pi session is resolved by the runtime. */
export const PRIMARY_CHAT = '1'

/** The chat kinds: the primary `main`, a side `thread` the owner branched or started, a `subagent`. */
export const ConversationKind = Schema.Literals(['main', 'thread', 'subagent'])
export type ConversationKind = typeof ConversationKind.Type

/**
 * A conversation of the agent the owner can open. `parent` is the conversation it came from: the one a thread branched
 * from (or main for one started empty) and the spawner of a subagent; only main has none. `forkEntry` is the entry of
 * the parent a thread branched at. `replies` are the messages written in it (the owner's and the agent's, not the
 * history it inherited) and `lastReplyAt` when the newest was. A closed conversation (`closedAt`, by the owner or
 * `done` after a subagent's last report) stays readable and reopens; `keepOpen` stops a subagent closing itself.
 * Times are in seconds. Whether it is working right now is not here: the workspace feed carries that.
 */
export const ConversationView = Schema.Struct({
  id: Schema.String,
  primary: Schema.optional(Schema.Boolean),
  kind: ConversationKind,
  title: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  forkEntry: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  closedBy: Schema.optional(Schema.Literals(['owner', 'done'])),
  keepOpen: Schema.Boolean,
  replies: Schema.Number,
  lastReplyAt: Schema.optional(Schema.Number),
  /** When the owner last saw the newest reply (seconds): a later `lastReplyAt` is unread. */
  readAt: Schema.optional(Schema.Number),
  /** The Topic it belongs to (Personal when absent, from a server older than Topics). */
  topic: Schema.optional(TopicId),
  /** It is its Topic's one Conversation (a channel), not a Thread. */
  conversation: Schema.optional(Schema.Boolean),
  /** What in it waits for the owner (questions, approvals, grants), for Activity. */
  attention: Schema.optional(Schema.Array(Attention)),
  /** A Thread a running or finished turn was moved into: the chat it left and the move's operation id. */
  movedFrom: Schema.optional(Schema.Struct({ chat: ChatId, operationId: Schema.String })),
})
export type ConversationView = typeof ConversationView.Type

/** Rename, close or reopen (with everything under it), or pin a subagent open. */
export const UpdateConversation = Schema.Struct({
  title: Schema.optional(NonEmptyString(120)),
  closed: Schema.optional(Schema.Boolean),
  keepOpen: Schema.optional(Schema.Boolean),
})
export type UpdateConversation = typeof UpdateConversation.Type

/**
 * What a conversation's agent is doing: `working` on a run, `waiting` with only its subagents at work, or `idle`.
 * `since` (milliseconds) is when that began.
 */
export const ConversationActivity = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(['idle', 'working', 'waiting']),
  since: Schema.Number,
})
export type ConversationActivity = typeof ConversationActivity.Type

/**
 * One question the agent asks the owner with `ask_user`. A choice question (`single`, `multi`) offers 2 to 8 options;
 * `allowOther` adds a free answer. The tool result's details are `{ kind: 'question', questions }`.
 */
export const QuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export const QuestionSpec = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  kind: Schema.Literals(['single', 'multi', 'text']),
  options: Schema.optional(Schema.Array(QuestionOption)),
  allowOther: Schema.optional(Schema.Boolean),
})
export type QuestionSpec = typeof QuestionSpec.Type

/**
 * What an open App shared for the agent (`ui/update-model-context`), sent with the owner's next message by its App id.
 * The runtime finds where the App comes from (its server, or the agent app it is) and passes the text to the model as
 * a separate block labelled untrusted, never as the owner's words.
 */
export const AppContext = Schema.Struct({
  app: AppId,
  text: NonEmptyString(8192),
})
export type AppContext = typeof AppContext.Type

/**
 * The body of an owner message: `POST /api/conversations/:id/messages`, and `…/threads` to post it as the head of a new
 * Thread whose reply lands in that Thread. With Persona selections the tagged Personas answer instead of Goblin, in
 * parallel unless `personaOrder` is `sequence` ("then").
 */
/** The most Apps whose context one owner message carries. */
export const MAX_APP_CONTEXT = 2

export const SendMessage = Schema.Struct({
  input: Schema.String.check(Schema.isMaxLength(20_000)),
  operationId: OperationId,
  appContext: Schema.optional(Schema.Array(AppContext).check(Schema.isMaxLength(MAX_APP_CONTEXT))),
  attachments: Schema.optional(Schema.Array(FilePath).check(Schema.isMaxLength(8))),
  selections: Schema.optional(ComposerSelections),
  personaOrder: Schema.optional(Schema.Literals(['parallel', 'sequence'])),
})
export type SendMessage = typeof SendMessage.Type

/**
 * Pi's receipt for the owner's message: the session it went to, its operation id, and whether this call admitted it
 * (`false` when the operation id was already submitted).
 */
export const MessageReceipt = Schema.Struct({
  operationId: Schema.String,
  session: Schema.String,
  accepted: Schema.Boolean,
})
export type MessageReceipt = typeof MessageReceipt.Type

/** `POST …/stop`: the owner's Stop, optionally naming the one operation to stop. */
export const StopConversation = Schema.Struct({ operationId: Schema.optional(OperationId) })
export type StopConversation = typeof StopConversation.Type

/** A thread operation's anchor at an entry of the chat (Reply). */
const EntryAnchor = Schema.Struct({ entry: EntryId })

/**
 * Where a thread operation starts its Thread in the chat: at an entry (Reply), `empty` ("+"), or `latest` (the
 * composer's Start thread: the chat's newest settled entry, or empty when it has none, with the message posted as the
 * Thread's head in the chat).
 */
export const ThreadAnchor = Schema.Union([EntryAnchor, Schema.Literals(['empty', 'latest'])])
export type ThreadAnchor = typeof ThreadAnchor.Type

/**
 * The thread operation (ADR 0034), `POST /api/conversations/:id/threads`, for Reply, "+" and Start thread: start the
 * Thread at `anchor` of the chat, then send `message` as its first message, answered there. The same `operationId`
 * finds the same Thread, so a double click or a retry never makes two. The first message's own operation id derives
 * from `operationId`.
 */
export const StartThread = Schema.Struct({
  operationId: OperationId,
  anchor: ThreadAnchor,
  message: Schema.Struct({
    input: SendMessage.fields.input,
    appContext: SendMessage.fields.appContext,
    attachments: SendMessage.fields.attachments,
    selections: SendMessage.fields.selections,
  }),
  personaOrder: SendMessage.fields.personaOrder,
})
export type StartThread = typeof StartThread.Type

/** What a thread operation returns: the Thread as it is now and the receipt of the owner's message in it. */
export const StartedThread = Schema.Struct({ thread: ConversationView, receipt: MessageReceipt })
export type StartedThread = typeof StartedThread.Type

/**
 * `POST /api/conversations`: the thread operation without a message. With `from`, the Thread starts at that entry of
 * an open chat (in its Topic); without it, empty under `topic`'s Conversation, else Personal's. With an `operationId`
 * it is that chat's thread operation, so the same id finds the same Thread; without one, each call makes a new Thread.
 */
export const CreateConversation = Schema.Struct({
  operationId: Schema.optional(OperationId),
  topic: Schema.optional(TopicId),
  from: Schema.optional(Schema.Struct({ conversation: ChatId, ...EntryAnchor.fields })),
})
export type CreateConversation = typeof CreateConversation.Type
const AUTHOR_TAG = /^\[from ([^\]\n]{1,80})\]$/u

/**
 * Who wrote a message into a conversation when it was not the owner's own browser (Telegram, an MCP client, a
 * subagent): its content starts with a text block holding only this tag. The model reads it as written.
 */
export const authorTag = (author: string): string => `[from ${author.replaceAll(/[\]\n]/gu, ' ').slice(0, 80)}]`

/** The author named by a leading tag block, if that is what the block is. */
export const authorOf = (block: string): string | undefined => AUTHOR_TAG.exec(block)?.[1]

/** The author of a message the owner sent from Telegram: their own words, from their phone. */
export const TELEGRAM_AUTHOR = 'Telegram'
