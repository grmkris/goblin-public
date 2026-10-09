import * as Schema from 'effect/Schema'
import { ChatId, EntryId, OperationId } from './ids.ts'

/**
 * `POST /api/conversations/:id/move`: move the owner's message `entry` and the turn it started into a new Thread.
 * The same operation id finds the same move. The message stays in the channel as the Thread's head.
 */
export const MoveToThread = Schema.Struct({ entry: EntryId, operationId: OperationId })
export type MoveToThread = typeof MoveToThread.Type

/**
 * What a move did. `swap` moved a running turn (the run continues in the Thread); `settled` moved a finished one.
 * `refused` says why not (for example `streaming` where only settled turns can move, or `not_latest`).
 */
export const MoveReceipt = Schema.Struct({
  operationId: OperationId,
  chat: ChatId,
  thread: Schema.optional(ChatId),
  mode: Schema.Literals(['swap', 'settled']),
  state: Schema.Literals(['requested', 'forked', 'swapped', 'settled', 'refused']),
  reason: Schema.optional(Schema.String),
})
export type MoveReceipt = typeof MoveReceipt.Type

/**
 * `app.thread_head` entry data, written into the chat a Thread started from: the head shows `text` (bounded, display
 * only) and links `thread`. `moved` marks a turn moved out of this chat; otherwise the owner started the Thread from
 * the composer.
 */
export const ThreadHeadData = Schema.Struct({
  thread: ChatId,
  text: Schema.String.check(Schema.isMaxLength(400)),
  author: Schema.optional(Schema.String),
  moved: Schema.optional(Schema.Boolean),
  operationId: OperationId,
})
export type ThreadHeadData = typeof ThreadHeadData.Type

/**
 * `app.delegate_result` entry data: a Delegate's (subagent's) attributed result posted in the chat that assigned it.
 * Goblin does not answer it again unless the assignment asked for synthesis (spec §5).
 */
export const DelegateResultData = Schema.Struct({
  delegate: ChatId,
  name: Schema.String,
  status: Schema.Literals(['done', 'failed', 'stopped']),
  text: Schema.String,
})
export type DelegateResultData = typeof DelegateResultData.Type

/** Something in a chat that waits for the owner, collected in Activity and linked to its origin. */
export const Attention = Schema.Struct({
  kind: Schema.Literals(['question', 'approval', 'grant', 'capability', 'app-power']),
  since: Schema.Number,
  entry: Schema.optional(EntryId),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
})
export type Attention = typeof Attention.Type

/**
 * A message only the owner sees, shown in a chat after `afterEntry` and never part of its transcript: a suggestion the
 * owner can act on or dismiss. Each action has a stable id the runtime understands.
 */
export const EphemeralMessage = Schema.Struct({
  id: Schema.String,
  chat: ChatId,
  afterEntry: Schema.optional(EntryId),
  title: Schema.String.check(Schema.isMaxLength(120)),
  body: Schema.String.check(Schema.isMaxLength(2000)),
  actions: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
      label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40)),
      tone: Schema.Literals(['primary', 'neutral', 'danger']),
    }),
  ).check(Schema.isMaxLength(3)),
  createdAt: Schema.Number,
})
export type EphemeralMessage = typeof EphemeralMessage.Type
