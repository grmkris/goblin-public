import type { EntryDraft, EntryRecord, Submission, UserInput } from '@earendil-works/pi-durable'
import type {
  ConversationKind,
  ConversationView,
  CreateConversation,
  HelperExclusion,
  MoveReceipt,
  MoveToThread,
  ThreadAnchor,
  UpdateConversation,
} from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import type { PiReceipt } from 'agents/harness/pi'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type { AppError } from '../http/errors.ts'
import type { ChatId, ChatRow, SessionId } from './directory.ts'
import type { Receipt, ReceiptChange, ReceiptInput, ReceiptOrigin } from './receipts.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** Conversations a write made, changed or closed, by chat id (ADR 0030). */
    'conversations.changed': { readonly ids: readonly string[] }
  }
}

/**
 * The conversation services (ADRs 0030, 0032, 0034) as Effects. Each reads the current time from the Clock and fails
 * with a typed `AppError`. `Chats` and `ChatOperations` are native (layers/conversation.ts); `Conversations` and
 * `Moves` still wrap the legacy start's registry and mover, the agent's one instance of each, which other lanes'
 * instances share.
 */

/** Stable chat identities over Pi sessions (ADR 0030): which session a chat is on now, and where it sits. */
export class Chats extends Context.Service<
  Chats,
  {
    /** Personal's Conversation, Main: the inbound target. */
    readonly primary: ChatId
    /** The Pi session a registered chat is on now; anything else is `NotFound`. */
    readonly session: (chat: string) => Effect.Effect<SessionId, AppError>
    /** The chat a Pi session belongs to, if any. */
    readonly chatOf: (session: string) => Effect.Effect<Option.Option<ChatId>, AppError>
    /** The Topic a registered chat belongs to. */
    readonly topicOf: (chat: string) => Effect.Effect<number, AppError>
    /** A Topic's one Conversation. */
    readonly conversationOf: (topic: number) => Effect.Effect<ChatId, AppError>
    /** The Conversation `chat` sits under: itself when it is one, else the nearest one up its parents. */
    readonly conversationAbove: (chat: string) => Effect.Effect<ChatId, AppError>
    /** Whether `chat` is a Topic's one Conversation (a channel). */
    readonly isConversation: (chat: string) => Effect.Effect<boolean, AppError>
    /** Whether `chat` is a Persona's hidden fork (ADR 0033): never listed, never reported on its own. */
    readonly isHidden: (chat: string) => Effect.Effect<boolean, AppError>
    /**
     * Registers a chat's row (`registerChat`, the one chat-row inserter); a chat registered already fails, unless
     * `again` is `keep`. True when this call wrote the row.
     */
    readonly register: (row: ChatRow, again?: 'fail' | 'keep') => Effect.Effect<boolean, AppError>
  }
>()('goblin/chats/Chats') {}

/**
 * One write into a chat its model sees at its next turn; no run starts. The request id makes a repeat the same write
 * and is its receipt's operation id: kind `write:<entry kind>`, from `origin` (`system` unless said), made by
 * `parentOp` when another operation led to it.
 */
export type PassiveWrite = {
  readonly requestId: string
  readonly entry: EntryDraft
  readonly origin?: ReceiptOrigin
  readonly parentOp?: string
}

/** A passive write into a chat other than the one asking: where it goes, and the write (`ChatOperations.passiveWrite`). */
export type ChatWrite = { readonly chat: string; readonly write: PassiveWrite }

/** An admitted operation: the session it went to, and whether it was admitted before (a replay). */
export type Admitted = { readonly session: SessionId; readonly existing: boolean }

/**
 * The flow event an admission records once it ends (plan §4), besides its chat, operation, status and time: the flow,
 * how it came in, who acted, and what else it says (a Persona ask's count and order).
 */
export type AdmissionFlow = Pick<FlowEvent, 'flow' | 'via' | 'actor'> &
  Partial<Pick<FlowEvent, 'parentChat' | 'topic' | 'parentOperation' | 'count' | 'personaOrder' | 'synthesize'>>

/** One operation into a chat: which, what its receipt says, and the flow it records. */
export type Admission = {
  readonly chat: string
  readonly operationId: string
  readonly receipt: ReceiptInput
  readonly flow: AdmissionFlow
}

/** One input into a chat through the one admission sequence (`ChatOperations.send`). */
export type Submit<R> = Admission & {
  /** What Pi takes as the input. */
  readonly content: UserInput
  /**
   * A routine's question waiting in the chat takes the input as its answer instead of Pi, under the chat's lock: true
   * when one did (the owner's message wires the routines' answer here).
   */
  readonly answer?: (session: SessionId) => Effect.Effect<boolean, AppError, R>
  /** Where the input goes instead of Pi's submit (the owner's message to a subagent goes through its relay). */
  readonly relay?: (session: SessionId) => Effect.Effect<PiReceipt, AppError, R>
}

/**
 * What happens in a chat by operation (plan §3): admission (an operation's receipt is recorded before Pi sees it, and a
 * replay keeps its first session), the one admission sequence of an input, and passive writes, each under the chat's
 * admission lock (`KeyedLock`). The lock covers admission only, never a model call or a wait.
 */
export class ChatOperations extends Context.Service<
  ChatOperations,
  {
    /**
     * Records `operationId`'s receipt in `chat` before it reaches Pi, with no lock and no check that the chat takes new
     * work (`admit` does both); a replay finds the session it was first admitted to.
     */
    readonly record: (chat: string, operationId: string, receipt: ReceiptInput) => Effect.Effect<Admitted, AppError>
    /** The session `operationId` was admitted to in `chat`, if it was. */
    readonly operation: (chat: string, operationId: string) => Effect.Effect<Option.Option<SessionId>, AppError>
    /** `operationId`'s receipt in `chat`, if it was admitted there. */
    readonly receipt: (chat: string, operationId: string) => Effect.Effect<Option.Option<Receipt>, AppError>
    /** Every receipt `operationId` led to, in any chat, oldest first. */
    readonly related: (operationId: string) => Effect.Effect<readonly Receipt[], AppError>
    /** Moves `operationId`'s receipt in `chat` on: submitted, written, refused (with a reason) or settled. */
    readonly advance: (
      chat: string,
      operationId: string,
      change: Omit<ReceiptChange, 'now'>,
    ) => Effect.Effect<void, AppError>
    /**
     * `work` as `operationId`'s operation in `chat`: its receipt is recorded first (a replay finds its first session),
     * then `work` runs, then `end` moves the receipt on with what it made (`submitted`, `settled`, …). A failure of
     * `work` leaves the receipt `refused` with the failure's type. No lock: callers that need one take it.
     */
    readonly tracked: <A, E, R>(
      chat: string,
      operationId: string,
      receipt: ReceiptInput,
      work: (admitted: Admitted) => Effect.Effect<A, E, R>,
      end: (value: A) => Omit<ReceiptChange, 'now'>,
    ) => Effect.Effect<A, E | AppError, R>
    /**
     * Runs `effect` holding `chat`'s admission lock: one at a time per chat, in arrival order. An interruption while
     * waiting for the lock waits for it, then lets it go. Not re-entrant: nothing inside takes `chat`'s lock again.
     */
    readonly withChat: <A, E, R>(chat: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
    /** Writes into `chat` under its admission lock: the receipt, then Pi's write into the session it names. */
    readonly passiveWrite: (chat: string, write: PassiveWrite) => Effect.Effect<Submission, AppError>
    /**
     * Admits `admission` and runs `then` on it, under the chat's lock: the chat must take new work, the receipt is
     * recorded (a replay finds its first session), then `then` hands the operation on. The receipt ends `submitted`, or
     * `refused` with the failure's type, and the flow is recorded once, `replayed` for a replay.
     */
    readonly admit: <A, E, R>(
      admission: Admission,
      then: (admitted: Admitted) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AppError, R>
    /**
     * The one admission sequence of an input: within the budget, admitted (`admit`), a routine's waiting question
     * answered through `answer` when it takes the input, the session put on the owner's model, then Pi's submit or
     * the `relay`.
     */
    readonly send: <R = never>(input: Submit<R>) => Effect.Effect<PiReceipt, AppError, R>
  }
>()('goblin/chats/ChatOperations') {}

/**
 * Where a thread operation starts its Thread (ADR 0034): forked at an entry of the chat (Reply), empty under the
 * Conversation the chat sits under ("+"), or forked at the chat's newest settled entry (Start thread, `latest`).
 */
export type { ThreadAnchor }

/** A page of a chat's history before an entry, oldest first, and whether older entries remain. */
export type HistoryPage = { readonly entries: readonly EntryRecord[]; readonly more: boolean }

/** A subagent's latest report as the composer references it: bounded, and labelled as reference data there. */
export type HelperReference = {
  readonly conversationId: string
  readonly label: string
  readonly status: string
  readonly report: string
}

/** What an update did: the chat as it is now, and every chat a Close closed (it and those below). */
export type Updated = { readonly view: ConversationView; readonly closed: readonly string[] }

/** A routine's frozen report into its Topic's Conversation (Personal's by default). */
export type RoutineReport = {
  readonly runId: string
  readonly routineId: string
  readonly sessionId: string | null
  readonly outcome: string
  readonly text: string
  readonly at: number
  readonly topic?: number
}

/**
 * The registry of the owner's chats (ADR 0030): what Pi does not keep (kind, title, origin, closed) and the gate in
 * front of Pi, since a chat id resolves to its session only once registered. Threads, Topic Conversations, subagents,
 * Persona forks and routine chats are registered here.
 */
export class Conversations extends Context.Service<
  Conversations,
  {
    /** The Pi session of a registered chat; anything else is `NotFound`. */
    readonly require: (chat: string) => Effect.Effect<string, AppError>
    /** The Pi session of a registered chat that takes new work: open, not a Persona's, its Topic not archived. */
    readonly requireOpen: (chat: string) => Effect.Effect<string, AppError>
    readonly kindOf: (chat: string) => Effect.Effect<ConversationKind, AppError>
    /** The immutable Pi session holding a subagent's anchor and relays. */
    readonly spawnerSession: (chat: string) => Effect.Effect<string, AppError>
    /** One registered chat as the owner sees it. */
    readonly view: (chat: string) => Effect.Effect<Option.Option<ConversationView>, AppError>
    /** Every registered chat but Persona forks, oldest first, closed ones included. */
    readonly list: Effect.Effect<readonly ConversationView[], AppError>
    /** A subagent's latest report, for the composer's reference. */
    readonly helperReference: (chat: string) => Effect.Effect<HelperReference, AppError>
    /**
     * The owner's create: a Thread branched from an entry of an open chat, or an empty one under a Topic's. With an
     * operation id it is that chat's thread operation (`startThread`), so a repeat finds the same Thread.
     */
    readonly create: (input: CreateConversation) => Effect.Effect<ConversationView, AppError>
    /**
     * The Thread operation `operationId` starts from `parent` at `anchor`: one per operation, also when repeated, with
     * its receipt in `parent` and its `start`, `reply` or `empty` flow.
     */
    readonly startThread: (
      parent: string,
      operationId: string,
      anchor: ThreadAnchor,
    ) => Effect.Effect<ConversationView, AppError>
    /** A new Topic's Conversation: a new Pi session configured like Personal's. Returns its session. */
    readonly openConversation: Effect.Effect<string, AppError>
    /** Tells the change listeners about chats another registry wrote. */
    readonly touched: (chats: readonly string[]) => Effect.Effect<void, AppError>
    /** The open chats of `topic` other than subagents. */
    readonly openIn: (topic: number) => Effect.Effect<readonly string[], AppError>
    /** How far a thread cut from `chat` at `entry` may zoom into its memory; `null` for none. */
    readonly recallAt: (chat: string, entry: number) => Effect.Effect<number | null, AppError>
    /** How far `zoom` reaches from `session` into the memory above it (`size` messages). */
    readonly recallLimit: (session: string, size: number) => Effect.Effect<number, AppError>
    readonly registerSubagent: (
      session: string,
      parent: string,
      name: string,
      exclusions?: readonly HelperExclusion[],
    ) => Effect.Effect<void, AppError>
    readonly registerPersona: (session: string, parentChat: string, name: string) => Effect.Effect<void, AppError>
    readonly registerRoutine: (
      session: string,
      runId: string,
      title: string,
      topic?: number,
    ) => Effect.Effect<void, AppError>
    readonly reportRoutine: (report: RoutineReport) => Effect.Effect<void, AppError>
    /** A thread's note into the chat it came from; returns how that chat is named. */
    readonly shareBack: (thread: string, note: string, requestId: string) => Effect.Effect<string, AppError>
    /** Tells a "+" thread's Conversation about it once it has a title; true only when this call wrote the note. */
    readonly announce: (thread: string) => Effect.Effect<boolean, AppError>
    /**
     * Writes `entry` into `chat` passively; `placed` waits, outside the chat's lock, until it is in the transcript and
     * gives its entry id.
     */
    readonly writeEntry: (
      chat: string,
      requestId: string,
      entry: EntryDraft,
    ) => Effect.Effect<{ readonly placed: Effect.Effect<Option.Option<number>, AppError> }, AppError>
    /** Names an untitled thread from its latest exchange with the cheap model. */
    readonly nameIfUntitled: (thread: string) => Effect.Effect<void, AppError>
    readonly history: (chat: string, before: number) => Effect.Effect<HistoryPage, AppError>
    /** Rename, close or reopen, or pin a subagent open; a Close stops what it closes. */
    readonly update: (chat: string, change: UpdateConversation) => Effect.Effect<Updated, AppError>
    /** `chat` and every chat under it, any depth, closed ones included. */
    readonly subtree: (chat: string) => Effect.Effect<readonly string[], AppError>
    /** The owner has seen `chat` up to now. */
    readonly markRead: (chat: string) => Effect.Effect<void, AppError>
    /** Closes `chat` and every open chat under it, then stops each. Returns what it closed. */
    readonly close: (chat: string, by: 'owner' | 'done') => Effect.Effect<readonly string[], AppError>
    /** Stops every open subagent below `chat`; call it before stopping `chat` itself. */
    readonly stopSubagents: (chat: string) => Effect.Effect<void, AppError>
  }
>()('goblin/chats/Conversations') {}

/** Move to thread (ADR 0034): a chat's newest settled turn into a new Thread, once per operation. */
export class Moves extends Context.Service<
  Moves,
  {
    /** The move `input.operationId` names, made once: a repeat returns its receipt as it is now. */
    readonly move: (chat: string, input: MoveToThread) => Effect.Effect<MoveReceipt, AppError>
    /** Whether `chat` is in the middle of a move. */
    readonly moving: (chat: string) => Effect.Effect<boolean, AppError>
  }
>()('goblin/chats/Moves') {}
