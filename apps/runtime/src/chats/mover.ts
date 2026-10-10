import type { Conversation, EntryRecord, Extension, Harness, ToolRegistration } from '@earendil-works/pi-durable'
import { authorOf, type MoveReceipt, type MoveToThread } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { copyExclusions, piToolsFor } from '../capabilities/profiles.ts'
import { nowSeconds } from '../clock.ts'
import type { ConversationRegistry } from '../conversations.ts'
import type { ChatMemories } from '../memory/memory.ts'
import { Conflict, NotFound } from '../http/errors.ts'
import { movedToThreadContent } from '../pi/content.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import { forkThread, stopBuilder, turnEntries, turnRelays } from '../pi/moves.ts'
import type { SubagentKit } from '../pi/subagents.ts'
import { textBlocks } from '../pi/transcript.ts'
import { latestTurnStart, runInputEntries } from '../pi/turns.ts'
import { reassignExcerpts } from '../retrieval/index.ts'
import { writeLine } from '../observability/logger.ts'
import { framesOf, safeErrorType } from '../observability/report.ts'
import { Moves } from './service.ts'
import * as Context from 'effect/Context'
import { appMcpApprovals } from '../storage/mcp-approvals.ts'
import { chatSession, isConversationChat, topicOfChat } from './directory.ts'
import { type MoveRow, MoveStore, moveReceipt } from './moves.ts'
import { submitThreadHead } from './thread-heads.ts'

/** The boundaries a move commits at, where a test may stop the object to prove a restart finishes the move. */
export type MovePhase = 'fork' | 'head'

/** What the mover works with: the agent's database and registry, Pi, and the thread's own extensions. */
export type MoverPorts = {
  readonly db: DrizzleSqliteDODatabase
  readonly harness: PiHarness
  /** Runs `run` while `chat`'s admission lock is held: `ChatOperations.withChat`, the one lock per chat. */
  readonly withChat: <A>(chat: string, run: () => Promise<A>) => Promise<A>
  readonly conversations: ConversationRegistry
  /** The tools Pi's filter removes where subagents are switched off. */
  readonly subagentTools: readonly ToolRegistration[]
  /** Each Topic Conversation's memory: a move forgets the turn there. */
  readonly memories: ChatMemories
  readonly thread: Extension
  readonly recall: Extension
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

/**
 * Move to thread (ADR 0034), the settled-turn mechanism: the chat's newest turn, once it has finished, moves into a new
 * Thread. The Thread is a Pi fork of the chat at the turn's last entry; the chat keeps its session and omits the turn
 * from its model's context (Pi `edits`) in the head that stands for it. A running turn is refused (`streaming`): Pi
 * cannot move a running turn, and the identity swap that would let it continue elsewhere deepens the chat's fork chain
 * by one level per move (the ADR's measured kill criterion). Each move is one `app_chat_moves` row through
 * `requested`, `forked` and `settled`, or `refused`; the same operation id finds the same move, and a restart
 * finishes one it interrupted (`reconcile`). Nothing holds the chat's lock across a model call.
 */
export class ChatMover {
  readonly #ports: MoverPorts
  readonly #store: MoveStore
  readonly #running = new Map<string, Promise<void>>()

  constructor(ports: MoverPorts) {
    this.#ports = ports
    this.#store = new MoveStore(ports.db)
  }

  /** The move `input.operationId` names, made once: a repeat returns its receipt as it is now. */
  async move(chat: string, input: MoveToThread, now: number): Promise<MoveReceipt> {
    const existing = this.#store.get(input.operationId)
    if (existing !== undefined && (existing.chatId !== chat || existing.messageEntry !== input.entry))
      throw new Conflict({ reason: 'operation_used' })
    const row = existing ?? (await this.#ports.withChat(chat, async () => this.#begin(chat, input, now)))
    if (row.state !== 'refused' && row.mode === 'settled') await this.#finish(row.operationId)
    return moveReceipt(this.#store.require(row.operationId))
  }

  /** Finishes every move a restart interrupted, and refuses a swap that never settled. */
  async reconcile(): Promise<void> {
    this.#store.retireSwaps(nowSeconds())
    for (const row of this.#store.unfinished())
      await this.#finish(row.operationId).catch((error: unknown) => reportMove('reconcile', error))
  }

  /** Whether `chat` is in the middle of a move: its memory builder waits until the move settles. */
  moving(chat: string): boolean {
    return this.#store.active(chat) !== undefined
  }

  async #begin(chat: string, input: MoveToThread, now: number): Promise<MoveRow> {
    const again = this.#store.get(input.operationId)
    if (again !== undefined) return again
    if (this.#store.active(chat) !== undefined) throw new Conflict({ reason: 'moving' })
    const plan = await this.#plan(chat, input.entry)
    if (typeof plan === 'string')
      return this.#store.refuse({ operation: input.operationId, chat, entry: input.entry, reason: plan, now })
    return this.#store.begin({ operation: input.operationId, chat, entry: input.entry, now, ...plan })
  }

  /**
   * Whether `entry` can move out of `chat`: a Topic's Conversation, idle, and the owner's message there that started
   * its newest turn still shown (not one moved already), with no approval waiting on the owner. A reason when not.
   */
  async #plan(chat: string, entry: number): Promise<Plan | string> {
    const { db, conversations } = this.#ports
    if (!isConversationChat(db, chat)) return 'not_conversation'
    conversations.requireOpen(chat)
    const source = chatSession(db, chat)
    const pi = await this.#pi()
    const conversation = await pi.conversation(conversationId(source), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'conversation' })
    const id = entryId(entry)
    const [message] = (await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND)).items
    if (message?.kind !== 'pi.user' || String(message.conversationId) !== source) return 'not_user_message'
    if (this.#store.moved(chat, entry)) return 'moved'
    const queued = (await pi.inspect(BACKGROUND)).submissions.some(
      (submission) => String(submission.conversationId) === source && submission.type === 'input',
    )
    if (queued || (await runInputEntries(pi, source)).length > 0) return 'streaming'
    if ((await latestTurnStart(conversation, source)) !== message.id) return 'not_latest'
    if (this.#waiting(source)) return 'awaiting_approval'
    const turn = await turnEntries(pi, { source: conversationId(source), message: entry, end: Number.MAX_SAFE_INTEGER })
    return { source, end: turn.at(-1) ?? entry }
  }

  /** Whether an MCP call of the chat's session waits on the owner's approval: its continuation resumes that session. */
  #waiting(session: string): boolean {
    const pending = this.#ports.db
      .select({ id: appMcpApprovals.id })
      .from(appMcpApprovals)
      .where(and(eq(appMcpApprovals.sessionId, session), eq(appMcpApprovals.state, 'pending')))
      .get()
    return pending !== undefined
  }

  /** One move's remaining steps, one at a time per operation. */
  async #finish(operation: string): Promise<void> {
    const pending = this.#running.get(operation)
    if (pending !== undefined) return pending
    const step = this.#advance(operation).finally(() => this.#running.delete(operation))
    this.#running.set(operation, step)
    return step
  }

  /**
   * Fork, rows, head and memory under the chat's admission lock (each step finds its own result when repeated), then
   * the helpers' relays outside it: stopping a relay waits for it, and a relay's report waits for that lock.
   */
  async #advance(operation: string): Promise<void> {
    const first = this.#store.require(operation)
    if (first.state === 'requested' || first.state === 'forked')
      await this.#ports.withChat(first.chatId, async () => this.#thread(this.#store.require(operation)))
    const row = this.#store.require(operation)
    if (row.state !== 'forked') return
    const { source, fork } = required(row)
    const pi = await this.#pi()
    const [from, to] = [conversationId(source), conversationId(fork)]
    const ids =
      this.#store.relaysOf(row) ??
      this.#store.saveRelays(operation, await turnRelays(pi, from, row.messageEntry), nowSeconds())
    this.#store.respawn(source, fork, await this.#ports.handover(pi, { from, to, ids }))
    this.#store.settled(operation, nowSeconds())
    this.#ports.conversations.touched([row.chatId, row.threadChat ?? fork])
  }

  /** The Thread: its Pi fork, its rows, the head that omits the turn in the chat, and the chat's memory. */
  async #thread(begun: MoveRow): Promise<void> {
    const pi = await this.#pi()
    const row = begun.state === 'requested' ? await this.#fork(pi, begun) : begun
    const { source, fork, end } = required(row)
    const conversation = await pi.conversation(conversationId(source), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'conversation' })
    const message = entryId(row.messageEntry)
    const range = { minEntryId: message, maxEntryId: message }
    const words = wordsOf((await conversation.entries(range, 1, undefined, BACKGROUND)).items[0])
    if (row.threadChat === null) await this.#register(row, conversation, words.text)
    const head = {
      thread: fork,
      text: words.text.slice(0, HEAD_TEXT),
      operationId: row.operationId,
      moved: true,
      ...(words.author === undefined ? {} : { author: words.author }),
    }
    const omit = await turnEntries(pi, { source: conversationId(source), message: row.messageEntry, end })
    const title = (await this.#ports.conversations.view(fork))?.title ?? titleOf(words.text)
    await submitThreadHead(conversation, head, movedToThreadContent(title), omit)
    const { memories } = this.#ports
    memories.truncate(row.chatId, memories.of(row.chatId).sizeAt(row.messageEntry - 1))
    await this.#ports.after?.('head', row.operationId)
  }

  /** The Thread's Pi fork at the turn's end, made a thread with the chat's switches; the chat's builder stops first. */
  async #fork(pi: Harness, row: MoveRow): Promise<MoveRow> {
    const { db, conversations, subagentTools } = this.#ports
    const { source, end } = required(row)
    await stopBuilder(pi, conversationId(source))
    const recall = conversations.recallAt(row.chatId, row.messageEntry - 1) !== null
    const agent = {
      extensions: { add: recall ? [this.#ports.thread, this.#ports.recall] : [this.#ports.thread] },
      instructions: null,
      tools: piToolsFor(db, subagentTools, row.chatId),
    }
    const input = { operation: row.operationId, source: conversationId(source), agent }
    const fork = await forkThread(pi, { ...input, message: entryId(row.messageEntry), end: entryId(end) }).catch(
      (error: unknown) => {
        this.#store.abandon(row.operationId, 'fork_failed', nowSeconds())
        throw error
      },
    )
    const forked = this.#store.forked(row.operationId, String(fork), nowSeconds())
    await this.#ports.after?.('fork', row.operationId)
    return forked
  }

  /** The moved Thread's rows and switches: in the chat's Topic, showing its replies from the moved message on. */
  async #register(row: MoveRow, conversation: Conversation, text: string): Promise<void> {
    const { db, conversations } = this.#ports
    const { fork } = required(row)
    const before = { maxEntryId: entryId(row.messageEntry - 1) }
    const [previous] = (await conversation.entries(before, 1, undefined, BACKGROUND)).items
    const now = nowSeconds()
    const thread = {
      chat: fork,
      title: titleOf(text),
      topic: topicOfChat(db, row.chatId),
      before: previous?.id ?? null,
      recallThrough: conversations.recallAt(row.chatId, row.messageEntry - 1),
    }
    this.#store.register(row, thread, now)
    copyExclusions(db, row.chatId, fork, now)
    // The cross-Topic index (ADR 0035): the session's entries from the moved message on now belong to the Thread.
    reassignExcerpts(db, required(row).source, row.messageEntry, fork)
    conversations.touched([fork])
  }

  async #pi(): Promise<Harness> {
    return this.#ports.harness.pi()
  }
}

/** The sessions and turn end a move has from its `requested` row on. */
function required(row: MoveRow): { readonly source: string; readonly fork: string; readonly end: number } {
  if (row.sourceSession === null || row.cutEntry === null) throw new NotFound({ what: 'move' })
  return { source: row.sourceSession, fork: row.forkSession ?? '', end: row.cutEntry }
}

/**
 * Reports a move step that failed outside a request as the failure reporter does (observability/report.ts): where,
 * the error's type and its stack locations, never its message.
 */
function reportMove(step: string, error: unknown): void {
  writeLine('warn', {
    event: 'failure',
    where: `move.${step}`,
    'error.type': safeErrorType(error),
    ...(error instanceof Error ? { frames: framesOf(error) } : {}),
    severity: 'Warn',
  })
}

/** The agent's one mover, made at the start (`layers/conversation.ts`). Programs use `Moves`. */
export class MovesInstance extends Context.Service<MovesInstance, ChatMover>()('goblin/chats/MovesInstance') {}

/** `POST /api/conversations/:id/move`: the owner's Move to thread, as its receipt (ADR 0034). */
export const moveToThread = (chat: string, input: MoveToThread) => Moves.use((moves) => moves.move(chat, input))
