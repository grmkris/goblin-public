import type {
  Conversation,
  EntryId,
  EntryRecord,
  Extension,
  Harness,
  ToolRegistration,
} from '@earendil-works/pi-durable'
import { authorOf, type MoveReceipt, type MoveToThread } from '@goblin/contracts'
import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { copyExclusions, piToolsFor } from '../capabilities/profiles.ts'
import { epochSeconds } from '../clock.ts'
import { Conflict, NotFound, attempt, attemptSync } from '../http/errors.ts'
import { forgetFrom, rememberedThrough } from '../memory/store.ts'
import { FlowEvents, withFlow } from '../observability/flows.ts'
import { reportAndRecover } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { movedToThreadContent } from '../pi/content.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import { forkThread, stopBuilder, turnEntries, turnRelays } from '../pi/moves.ts'
import { PiSessions, fromPi } from '../pi/sessions.ts'
import type { SubagentKit } from '../pi/subagents.ts'
import { textBlocks } from '../pi/transcript.ts'
import { latestTurnStart, runInputEntries } from '../pi/turns.ts'
import { reassignExcerpts } from '../retrieval/index.ts'
import { Changes } from '../runtime/changes.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { appMcpApprovals } from '../storage/mcp-approvals.ts'
import { recallFrom } from './conversations/reads.ts'
import { chatRow, isConversationChat, openChatSession, topicOfChat } from './directory.ts'
import {
  type MoveRow,
  abandonMove,
  activeMove,
  beginMove,
  forkedMove,
  moveOf,
  moveReceipt,
  movedRelays,
  refuseMove,
  registerMovedThread,
  requireMove,
  respawnHelpers,
  retireSwaps,
  saveRelays,
  settleMove,
  turnMoved,
  unfinishedMoves,
} from './moves.ts'
import { ChatOperations, Moves } from './service.ts'
import { submitThreadHead } from './thread-heads.ts'

/** The boundaries a move commits at, where a test may stop the object to prove a restart finishes the move. */
export type MovePhase = 'fork' | 'head'

/**
 * What a move hands to code outside the services: the subagents kit, which hands the moved turn's relays over to the
 * Thread, and the boundaries tests stop at.
 */
export type MoverPorts = {
  readonly handover: SubagentKit['handover']
  readonly after?: (phase: MovePhase, operation: string) => Promise<void>
}

/** The most of the moved message a head shows (`ThreadHeadData.text`). */
const HEAD_TEXT = 400

/** The owner's words in a user entry, and who wrote them when an author tag says someone else did. */
function wordsOf(entry: EntryRecord | undefined): { readonly text: string; readonly author?: string } {
  const message = entry?.model?.[0]
  const [first = '', second = ''] = message?.role === 'user' ? textBlocks(message.content) : []
  const author = authorOf(first)
  return author === undefined ? { text: first } : { text: second, author }
}

/** The moved Thread's title: the first line of the moved message, without quotes, at most 60 characters. */
const titleOf = (text: string): string => {
  const line = (text.split('\n').find((each) => each.trim() !== '') ?? '').replaceAll(/["'`*]/gu, '').trim()
  return line === '' ? 'Moved turn' : line.slice(0, 60)
}

/** What a move starts from: the chat's session and the last entry of the turn that moves. */
type Plan = { readonly source: string; readonly end: number }

/** What the mover works with, made once by its layer. */
type Mover = {
  readonly db: Db['Service']
  readonly pi: PiSessions['Service']
  readonly operations: ChatOperations['Service']
  readonly flights: SingleFlight['Service']
  readonly changes: Changes['Service']
  readonly thread: Extension
  readonly recall: Extension
  readonly subagentTools: readonly ToolRegistration[]
  readonly ports: MoverPorts
}

/** The sessions and turn end a move has from its `requested` row on. */
function required(row: MoveRow): { readonly source: string; readonly fork: string; readonly end: number } {
  if (row.sourceSession === null || row.cutEntry === null) throw new NotFound({ what: 'move' })
  return { source: row.sourceSession, fork: row.forkSession ?? '', end: row.cutEntry }
}

/** How far the moved Thread may zoom into the memory of the chat it leaves: as it was just before the moved message. */
function recallAt(db: Db['Service'], row: MoveRow): number | null {
  const chat = chatRow(db, row.chatId)
  if (chat === undefined) throw new NotFound({ what: 'conversation' })
  return recallFrom(db, chat, row.messageEntry - 1)
}

/** Pi's opened harness. */
const harnessOf = (mover: Mover) => fromPi(mover.pi.pi)

/** A test's boundary after `phase` committed (agent.ts `moveBoundary`). */
const after = (mover: Mover, phase: MovePhase, operation: string) =>
  attempt(async () => mover.ports.after?.(phase, operation))

/** Tells `conversations.changed` about the chats a move changed. */
const touched = (mover: Mover, ids: readonly string[]) => mover.changes.publish('conversations.changed', { ids })

/** Whether an MCP call of the chat's session waits on the owner's approval: its continuation resumes that session. */
const waiting = (db: Db['Service'], session: string): boolean =>
  db
    .select({ id: appMcpApprovals.id })
    .from(appMcpApprovals)
    .where(and(eq(appMcpApprovals.sessionId, session), eq(appMcpApprovals.state, 'pending')))
    .get() !== undefined

/**
 * Whether the turn the owner's message `message` started in `source` can move now: idle (nothing running or queued),
 * its newest turn, with no approval waiting on the owner. A reason when not, else the turn's last entry.
 */
const turnEnd = Effect.fn('Moves.turnEnd')(function* (
  mover: Mover,
  pi: Harness,
  turn: { readonly source: string; readonly conversation: Conversation; readonly message: EntryId },
) {
  const { source, conversation, message } = turn
  const queued = (yield* attempt(() => pi.inspect(BACKGROUND))).submissions.some(
    (submission) => String(submission.conversationId) === source && submission.type === 'input',
  )
  if (queued) return 'streaming'
  if ((yield* attempt(() => runInputEntries(pi, source))).length > 0) return 'streaming'
  if ((yield* attempt(() => latestTurnStart(conversation, source))) !== message) return 'not_latest'
  if (waiting(mover.db, source)) return 'awaiting_approval'
  const query = { source: conversationId(source), message: Number(message), end: Number.MAX_SAFE_INTEGER }
  const entries = yield* attempt(() => turnEntries(pi, query))
  return entries.at(-1) ?? Number(message)
})

/**
 * Whether `entry` can move out of `chat`: a Topic's Conversation, open, and the owner's message there that started its
 * newest turn still shown (not one moved already), the turn movable now (`turnEnd`). A reason when not.
 */
const plan = Effect.fn('Moves.plan')(function* (mover: Mover, chat: string, entry: number) {
  const { db } = mover
  if (!(yield* attemptSync(() => isConversationChat(db, chat)))) return 'not_conversation'
  const source = yield* attemptSync(() => openChatSession(db, chat))
  const pi = yield* harnessOf(mover)
  const conversation = yield* attempt(() => pi.conversation(conversationId(source), BACKGROUND))
  if (conversation === undefined) return yield* new NotFound({ what: 'conversation' })
  const id = entryId(entry)
  const range = { minEntryId: id, maxEntryId: id }
  const [message] = (yield* attempt(() => conversation.entries(range, 1, undefined, BACKGROUND))).items
  if (message?.kind !== 'pi.user' || String(message.conversationId) !== source) return 'not_user_message'
  if (turnMoved(db, chat, entry)) return 'moved'
  const end = yield* turnEnd(mover, pi, { source, conversation, message: message.id })
  return typeof end === 'string' ? end : ({ source, end } satisfies Plan)
})

/** A move's row once its chat's lock is held: the one already there, else refused or begun by its plan. */
const begin = Effect.fn('Moves.begin')(function* (mover: Mover, chat: string, input: MoveToThread) {
  const { db } = mover
  const again = moveOf(db, input.operationId)
  if (again !== undefined) return again
  if (activeMove(db, chat) !== undefined) return yield* new Conflict({ reason: 'moving' })
  const planned = yield* plan(mover, chat, input.entry)
  const now = yield* epochSeconds
  const move = { operation: input.operationId, chat, entry: input.entry, now }
  return yield* attemptSync(() =>
    typeof planned === 'string' ? refuseMove(db, { ...move, reason: planned }) : beginMove(db, { ...move, ...planned }),
  )
})

/** The Thread's Pi fork at the turn's end, made a thread with the chat's switches; the chat's builder stops first. */
const fork = Effect.fn('Moves.fork')(function* (mover: Mover, pi: Harness, row: MoveRow) {
  const { db } = mover
  const { source, end } = required(row)
  yield* attempt(() => stopBuilder(pi, conversationId(source)))
  const recall = (yield* attemptSync(() => recallAt(db, row))) !== null
  const agent = {
    extensions: { add: recall ? [mover.thread, mover.recall] : [mover.thread] },
    instructions: null,
    tools: yield* attemptSync(() => piToolsFor(db, mover.subagentTools, row.chatId)),
  }
  const input = { operation: row.operationId, source: conversationId(source), agent }
  const forked = yield* attempt(() =>
    forkThread(pi, { ...input, message: entryId(row.messageEntry), end: entryId(end) }),
  ).pipe(
    Effect.tapError(() =>
      Effect.flatMap(epochSeconds, (now) => Effect.sync(() => abandonMove(db, row.operationId, 'fork_failed', now))),
    ),
  )
  const now = yield* epochSeconds
  const moved = yield* attemptSync(() => forkedMove(db, row.operationId, String(forked), now))
  yield* after(mover, 'fork', row.operationId)
  return moved
})

/** The moved Thread's rows and switches: in the chat's Topic, showing its replies from the moved message on. */
const register = Effect.fn('Moves.register')(function* (
  mover: Mover,
  row: MoveRow,
  conversation: Conversation,
  text: string,
) {
  const { db } = mover
  const { source, fork: forked } = required(row)
  const before = { maxEntryId: entryId(row.messageEntry - 1) }
  const [previous] = (yield* attempt(() => conversation.entries(before, 1, undefined, BACKGROUND))).items
  const now = yield* epochSeconds
  yield* attemptSync(() => {
    const thread = {
      chat: forked,
      title: titleOf(text),
      topic: topicOfChat(db, row.chatId),
      before: previous?.id ?? null,
      recallThrough: recallAt(db, row),
    }
    registerMovedThread(db, row, thread, now)
    copyExclusions(db, row.chatId, forked, now)
    // The cross-Topic index (ADR 0035): the session's entries from the moved message on now belong to the Thread.
    reassignExcerpts(db, source, row.messageEntry, forked)
  })
  yield* touched(mover, [forked])
})

/** The Thread: its Pi fork, its rows, the head that omits the turn in the chat, and the chat's memory. */
const moveTurn = Effect.fn('Moves.moveTurn')(function* (mover: Mover, begun: MoveRow) {
  const { db } = mover
  const pi = yield* harnessOf(mover)
  const row = begun.state === 'requested' ? yield* fork(mover, pi, begun) : begun
  const { source, fork: forked, end } = required(row)
  const conversation = yield* attempt(() => pi.conversation(conversationId(source), BACKGROUND))
  if (conversation === undefined) return yield* new NotFound({ what: 'conversation' })
  const message = entryId(row.messageEntry)
  const range = { minEntryId: message, maxEntryId: message }
  const words = wordsOf((yield* attempt(() => conversation.entries(range, 1, undefined, BACKGROUND))).items[0])
  if (row.threadChat === null) yield* register(mover, row, conversation, words.text)
  const head = {
    thread: forked,
    text: words.text.slice(0, HEAD_TEXT),
    operationId: row.operationId,
    moved: true,
    ...(words.author === undefined ? {} : { author: words.author }),
  }
  const omit = yield* attempt(() => turnEntries(pi, { source: conversationId(source), message: row.messageEntry, end }))
  const title = chatRow(db, forked)?.title ?? titleOf(words.text)
  yield* attempt(() => submitThreadHead(conversation, head, movedToThreadContent(title), omit))
  // The chat's memory forgets the turn: every message from the moved one on.
  yield* attemptSync(() => forgetFrom(db, row.chatId, rememberedThrough(db, row.chatId, row.messageEntry - 1)))
  yield* after(mover, 'head', row.operationId)
})

/**
 * One move's remaining steps: fork, rows, head and memory under the chat's admission lock (each step finds its own
 * result when repeated), then the helpers' relays outside it: stopping a relay waits for it, and a relay's report
 * waits for that lock.
 */
const advance = Effect.fn('Moves.advance')(function* (mover: Mover, operation: string) {
  const { db } = mover
  const first = yield* attemptSync(() => requireMove(db, operation))
  if (first.state === 'requested' || first.state === 'forked')
    yield* mover.operations.withChat(
      first.chatId,
      Effect.flatMap(
        attemptSync(() => requireMove(db, operation)),
        (row) => moveTurn(mover, row),
      ),
    )
  const row = yield* attemptSync(() => requireMove(db, operation))
  if (row.state !== 'forked') return
  const { source, fork: forked } = required(row)
  const pi = yield* harnessOf(mover)
  const [from, to] = [conversationId(source), conversationId(forked)]
  const saved = movedRelays(row)
  const ids =
    saved ??
    (yield* Effect.flatMap(
      attempt(() => turnRelays(pi, from, row.messageEntry)),
      (relays) => Effect.flatMap(epochSeconds, (now) => attemptSync(() => saveRelays(db, operation, relays, now))),
    ))
  const helpers = yield* attempt(() => mover.ports.handover(pi, { from, to, ids }))
  const now = yield* epochSeconds
  yield* attemptSync(() => {
    respawnHelpers(db, source, forked, helpers)
    settleMove(db, operation, now)
  })
  yield* touched(mover, [row.chatId, row.threadChat ?? forked])
})

/** One move's remaining steps, one at a time per operation: a second caller joins the run in flight. */
const finish = (mover: Mover, operation: string) => mover.flights.run(`move:${operation}`, advance(mover, operation))

/** The move `input.operationId` names, made once: a repeat returns its receipt as it is now. */
const moveOnce = Effect.fn('Moves.moveOnce')(function* (mover: Mover, chat: string, input: MoveToThread) {
  const { db } = mover
  const existing = moveOf(db, input.operationId)
  if (existing !== undefined && (existing.chatId !== chat || existing.messageEntry !== input.entry))
    return yield* new Conflict({ reason: 'operation_used' })
  const row = existing ?? (yield* mover.operations.withChat(chat, begin(mover, chat, input)))
  if (row.state !== 'refused' && row.mode === 'settled') yield* finish(mover, row.operationId)
  return moveReceipt(yield* attemptSync(() => requireMove(db, row.operationId)))
})

/** Finishes every move a restart interrupted, and refuses a swap that never settled. */
const reconcile = (mover: Mover) =>
  Effect.gen(function* () {
    const now = yield* epochSeconds
    const unfinished = yield* attemptSync(() => {
      retireSwaps(mover.db, now)
      return unfinishedMoves(mover.db)
    })
    for (const row of unfinished)
      yield* finish(mover, row.operationId).pipe(reportAndRecover('move.reconcile', undefined))
  }).pipe(reportAndRecover('moves.reconcile', undefined), Effect.withSpan('Moves.reconcile'))

/** How a move's receipt goes on from what the mover answered: refused with its reason, or settled with its Thread. */
export const moveEnd = (receipt: MoveReceipt) =>
  receipt.state === 'refused'
    ? ({ state: 'refused', reason: receipt.reason ?? 'refused' } as const)
    : ({
        state: receipt.state === 'settled' ? 'settled' : 'submitted',
        ...(receipt.thread === undefined ? {} : { targetChat: receipt.thread }),
      } as const)

/**
 * Move to thread (ADR 0034), the settled-turn mechanism: the chat's newest turn, once it has finished, moves into a new
 * Thread. The Thread is a Pi fork of the chat at the turn's last entry; the chat keeps its session and omits the turn
 * from its model's context (Pi `edits`) in the head that stands for it. A running turn is refused (`streaming`): Pi
 * cannot move a running turn. Each move is one `app_chat_moves` row through `requested`, `forked` and `settled`, or
 * `refused`; the same operation id finds the same move, with its `move` receipt in the chat and its `move` flow. A
 * move's remaining steps run once at a time (`SingleFlight`), so a restart that finds a move unfinished finishes it
 * (`reconcile`, forked in the layer's scope, never holding up the start). Nothing holds the chat's lock across a model
 * call.
 */
export const makeMoves = Effect.gen(function* () {
  const { thread, memory, subagentTools, moves } = yield* AgentInput
  const flows = yield* FlowEvents
  const mover: Mover = {
    db: yield* Db,
    pi: yield* PiSessions,
    operations: yield* ChatOperations,
    flights: yield* SingleFlight,
    changes: yield* Changes,
    thread,
    recall: memory.recall,
    subagentTools,
    ports: moves,
  }
  yield* Effect.forkScoped(reconcile(mover))
  return Moves.of({
    move: Effect.fn('Moves.move')(function* (chat: string, input: MoveToThread) {
      const flow = { flow: 'move', via: 'app', actor: 'owner', chat, operationId: input.operationId } as const
      const moved = mover.operations.tracked(
        chat,
        input.operationId,
        { kind: 'move', origin: 'owner' },
        ({ existing }) => Effect.map(moveOnce(mover, chat, input), (receipt) => ({ receipt, existing })),
        ({ receipt }) => moveEnd(receipt),
      )
      const settled = yield* moved.pipe(
        withFlow(flow, ({ receipt, existing }) =>
          receipt.state === 'refused'
            ? { status: 'refused', errorType: receipt.reason ?? 'refused' }
            : { status: existing ? 'replayed' : 'ok' },
        ),
        Effect.provideService(FlowEvents, flows),
      )
      return settled.receipt
    }),
    moving: (chat: string) =>
      Effect.sync(() => activeMove(mover.db, chat) !== undefined).pipe(Effect.withSpan('Moves.moving')),
  })
})

/** `POST /api/conversations/:id/move`: the owner's Move to thread, as its receipt (ADR 0034). */
export const moveToThread = (chat: string, input: MoveToThread) => Moves.use((moves) => moves.move(chat, input))
