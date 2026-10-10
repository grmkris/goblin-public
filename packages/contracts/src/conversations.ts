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

/**
 * A thread from an entry of any open conversation, or (without `from`) an empty one under a Topic's Conversation:
 * `topic`'s, else Personal's.
 */
export const CreateConversation = Schema.Struct({
  /** Makes the create idempotent: the same id finds the same Thread. */
  operationId: Schema.optional(OperationId),
  topic: Schema.optional(TopicId),
  from: Schema.optional(
    Schema.Struct({
      conversation: ChatId,
      entry: EntryId,
    }),
  ),
})
export type CreateConversation = typeof CreateConversation.Type

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
export const SendMessage = Schema.Struct({
  input: Schema.String.check(Schema.isMaxLength(20_000)),
  operationId: OperationId,
  appContext: Schema.optional(Schema.Array(AppContext).check(Schema.isMaxLength(2))),
  attachments: Schema.optional(Schema.Array(FilePath).check(Schema.isMaxLength(8))),
  selections: Schema.optional(ComposerSelections),
  personaOrder: Schema.optional(Schema.Literals(['parallel', 'sequence'])),
})
export type SendMessage = typeof SendMessage.Type

/**
 * One idempotent thread operation for reply, "+" and Start thread: fork the Thread at `anchor.entry` of the chat (or
 * start it `empty`), then send `message` as its first message. The same `operationId` finds the same Thread, so a
 * double click or a retry never makes two. The first message's own operation id derives from `operationId`.
 */
export const StartThread = Schema.Struct({
  operationId: OperationId,
  anchor: Schema.Union([Schema.Struct({ entry: EntryId }), Schema.Literal('empty')]),
  message: Schema.Struct({
    input: SendMessage.fields.input,
    appContext: SendMessage.fields.appContext,
    attachments: SendMessage.fields.attachments,
    selections: SendMessage.fields.selections,
  }),
  personaOrder: SendMessage.fields.personaOrder,
})
export type StartThread = typeof StartThread.Type

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
