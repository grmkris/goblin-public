import type { Conversation, EntryDraft, EntryRecord, Extension, Tx } from '@earendil-works/pi-durable'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { PiHarness } from 'agents/harness/pi'
import * as Schema from 'effect/Schema'
import { chatSession } from '../chats/directory.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import { type LogMessage, logMessage, messageLine } from './log.ts'
import type { TextCompletion } from './model.ts'
import {
  type MemoryDb,
  beginMemory,
  forgetFrom,
  lastLogged,
  loggedAt,
  memoryState,
  newestInput,
  nodeSizes,
  nodeTexts,
  recordView,
  rememberMessage,
  rememberedCount,
  rememberedThrough,
  storeNode,
  viewReach,
} from './store.ts'
import { type Step, summarize } from './summarize.ts'
import {
  type Node,
  type Sizes,
  VIEW_BYTES,
  byteLength,
  childrenOf,
  firstOf,
  fold,
  nodeAt,
  nodeKey,
  renderLine,
} from './tree.ts'

const PAGE = 100
/** Context the summarizer sees before a stretch, at most (the summarizer keeps the newest lines within its own cap). */
const CONTEXT_LINES = 40

/**
 * How far main may run past its view, in estimated tokens the model reads verbatim, before a new view folds it in. A
 * new view rewrites the start of main's context, so placing one after every turn kept the provider's prompt cache cold;
 * past this much, the shorter context is worth the cache it costs.
 */
export const FOLD_TOKENS = 30_000

/**
 * The estimated tokens of main's entries as the model reads them after the view. The view itself is written after its
 * head, and it is the part a new view replaces, so it does not count.
 */
export const tailTokens = (entries: readonly EntryRecord[]): number =>
  entries
    .filter((entry) => entry.kind !== 'app.memory')
    .flatMap((entry) => entry.model ?? [])
    .reduce((sum, message) => sum + estimateMessageTokens(message), 0)

/** Settings of the memory: the view's size, the summary prompt and how often a view is placed. */
export type MemoryOptions = {
  readonly viewBytes?: number
  readonly summaryPrompt?: string
  /** {@link FOLD_TOKENS} by default; 0 places a view whenever there is a newer input. */
  readonly foldTokens?: number
}

/**
 * Something a chat's memory refers to is gone: the Conversation in Pi, a remembered message's row or its Pi entry, or
 * a summary a merge builds on. The memory's own tables or Pi no longer agree with what it wrote; it arrives as
 * `Internal`, and never carries the chat's words.
 */
class MemoryMissing extends Schema.TaggedError<MemoryMissing>()('MemoryMissing', {
  what: Schema.Literals(['conversation', 'message', 'entry', 'summary']),
}) {}

/** What one builder step did: there is more to build, or the memory has caught up. */
export type StepResult = 'more' | 'done'

/**
 * A view ready to be placed in the Conversation: the passive write that places it (its request id makes a repeat the
 * same write) and how far it reaches. Whoever writes it records it with `placed`.
 */
export type Placement = {
  readonly through: number
  readonly write: { readonly requestId: string; readonly entry: EntryDraft }
}

/** What a chat's memory works with: its tables (and the chat rows), Pi and the cheap model that summarizes. */
export type MemoryDeps = {
  readonly db: MemoryDb
  readonly harness: PiHarness
  readonly model: TextCompletion
}

/**
 * One Conversation's memory (ADR 0032), after OptChat: every message of a Topic's Conversation from activation on is
 * logged, summarized into a binary tree of one-line summaries by the cheap model, and folded into a view of
 * `VIEW_BYTES`. The view is written into that Conversation as an `app.memory` entry whose head is its newest input, the
 * way Pi places a compaction: the model then sees the view and, verbatim, everything from that input on. Nothing waits
 * for the summarizer: until a message is summarized it is simply still shown in full. The builder task
 * (`pi/memory.ts`) drives `step`; `zoom` opens a line. Every row is keyed by the chat id, and the chat's Pi session is
 * resolved on each use, so a rebind moves nothing here. It keeps no state of its own: any number of them over one
 * database agree.
 */
export class ChatMemory {
  readonly #chat: string
  readonly #db: MemoryDb
  readonly #deps: MemoryDeps
  readonly #options: MemoryOptions

  constructor(chat: string, deps: MemoryDeps, options: MemoryOptions = {}) {
    this.#chat = chat
    this.#db = deps.db
    this.#deps = deps
    this.#options = options
  }

  async #main(): Promise<Conversation> {
    const session = chatSession(this.#db, this.#chat)
    const main = await (await this.#deps.harness.pi()).conversation(conversationId(session), BACKGROUND)
    if (main === undefined) throw new MemoryMissing({ what: 'conversation' })
    return main
  }

  /** Whether the memory is on: activated once, its state kept. */
  active(): boolean {
    return memoryState(this.#db, this.#chat) !== undefined
  }

  /**
   * Turns the memory on, once: the Conversation gets `extensions` (the builder and `zoom`) and every message after its
   * newest entry is remembered. Older history stays in Pi, unseen by the model once the first view lands.
   */
  async activate(extensions: readonly Extension[]): Promise<void> {
    if (this.active()) return
    const main = await this.#main()
    const [newest] = (await main.entries({}, 1, undefined, BACKGROUND)).items
    await main.configure({ extensions: { add: extensions } }, BACKGROUND)
    beginMemory(this.#db, this.#chat, newest?.id ?? 0)
  }

  /** Starts the builder unless one runs: `start` runs in a commit on the chat, where the builder's record lives. */
  async startBuilder(start: (tx: Tx) => Promise<void>): Promise<void> {
    await (await this.#main()).commit(start, BACKGROUND)
  }

  /** Messages remembered so far. */
  size(): number {
    return rememberedCount(this.#db, this.#chat)
  }

  /** Messages remembered up to and including its entry `entry`: what a thread branched there may zoom into. */
  sizeAt(entry: number): number {
    return rememberedThrough(this.#db, this.#chat, entry)
  }

  /**
   * Forgets every message from `size` on, with each summary that covers one, and pulls the view back to `size` at most:
   * a moved turn (Move to thread) leaves the memory of the chat it left. The view entry already in Pi is the mover's.
   */
  truncate(size: number): void {
    forgetFrom(this.#db, this.#chat, size)
  }

  /** How far the newest view reaches, in messages. */
  viewThrough(): number {
    return viewReach(this.#db, this.#chat)
  }

  /**
   * One unit of work, writing the view itself: `advance`, then any view it made is written into the Conversation
   * directly and recorded. The agent places views through its chat operations instead (Memories.step), under the
   * chat's admission lock; this is the benchmark's path.
   */
  async step(signal: AbortSignal): Promise<StepResult> {
    const next = await this.advance(signal)
    if (next === 'more' || next === 'done') return next
    await (await this.#main()).submit({ type: 'write', ...next.write }, BACKGROUND)
    this.placed(next.through)
    return 'done'
  }

  /**
   * One unit of work: log the Conversation's new entries, then summarize the first message not summarized yet, else
   * build the merge the view waits for, else make a view that reaches further than the last one, once the
   * Conversation has run far enough past the last one ({@link FOLD_TOKENS}). A view is returned to be placed, not
   * written: after placing it, the caller records it with `placed`, and the memory has caught up.
   */
  async advance(signal: AbortSignal): Promise<StepResult | Placement> {
    await this.#collect()
    const total = this.size()
    const sizes = nodeSizes(this.#db, this.#chat)
    const leaves = [...sizes.keys()].filter((key) => key.startsWith('0:')).length
    if (leaves < total) {
      await this.#build({ level: 0, index: leaves }, sizes, signal)
      return 'more'
    }
    const through = newestInput(this.#db, this.#chat)
    if (through === undefined || through === 0) return 'done'
    const view = fold(through, sizes, this.#options.viewBytes ?? VIEW_BYTES)
    if (view.wanted !== undefined) {
      await this.#build(view.wanted, sizes, signal)
      return 'more'
    }
    if (through > this.viewThrough() && (await this.#pastFold()))
      return this.#placement(view.parts, view.bytes, through) ?? 'done'
    return 'done'
  }

  /** The view through message `through` is in the Conversation: the next one must reach further. */
  placed(through: number): void {
    recordView(this.#db, this.#chat, through)
  }

  /**
   * Whether what the model reads verbatim after the current view (from its head, or from activation before the first
   * view) is past the fold threshold. Reads the Conversation newest first and stops as soon as it is.
   */
  async #pastFold(): Promise<boolean> {
    const limit = this.#options.foldTokens ?? FOLD_TOKENS
    const state = memoryState(this.#db, this.#chat)
    if (limit <= 0 || state === undefined) return true
    const head = state.viewThrough === 0 ? undefined : loggedAt(this.#db, this.#chat, state.viewThrough)
    const from = entryId(head === undefined ? state.originEntry + 1 : head.entryId)
    const main = await this.#main()
    let tokens = 0
    let cursor: Parameters<Conversation['entries']>[2]
    do {
      const page = await main.entries({ minEntryId: from }, PAGE, cursor, BACKGROUND)
      tokens += tailTokens(page.items)
      if (tokens > limit) return true
      cursor = page.next
    } while (cursor !== undefined)
    return false
  }

  /** Line `id+n` opened into the two lines under it, or message `id` whole when `n` is 1; `limit` bounds the ids. */
  async zoom(id: number, n: number, limit: number): Promise<string> {
    const node = nodeAt(id, n)
    const missing = `No line ${id}+${n}.`
    if (node === undefined || id + n > limit) return missing
    if (n === 1) return `${id}+1|${messageLine(await this.#message(id))}`
    const children = childrenOf(node)
    const texts = nodeTexts(this.#db, this.#chat, children)
    const lines = children.map((child) => {
      const text = texts.get(nodeKey(child))
      return text === undefined ? undefined : renderLine(child, text)
    })
    return lines.every((line) => line !== undefined) ? lines.join('\n') : missing
  }

  /** Adds the Conversation's entries since the last remembered one, oldest first. */
  async #collect(): Promise<void> {
    const state = memoryState(this.#db, this.#chat)
    if (state === undefined) return
    const last = lastLogged(this.#db, this.#chat)
    const main = await this.#main()
    const fresh: EntryRecord[] = []
    let cursor: Parameters<Conversation['entries']>[2]
    do {
      const page = await main.entries(
        { minEntryId: entryId((last?.entryId ?? state.originEntry) + 1) },
        PAGE,
        cursor,
        BACKGROUND,
      )
      fresh.push(...page.items)
      cursor = page.next
    } while (cursor !== undefined)
    let idx = last === undefined ? 0 : last.idx + 1
    // A turn moved to a Thread (ADR 0034) stays in the Conversation's session, omitted by its head: never remembered.
    const omitted = new Set(
      fresh.flatMap((entry) => (entry.edits ?? []).flatMap((edit) => (edit.action === 'omit' ? [edit.target] : []))),
    )
    for (const entry of fresh.toReversed()) {
      if (omitted.has(entry.id)) continue
      const message = logMessage(entry)
      if (message === undefined) continue
      rememberMessage(this.#db, this.#chat, idx, { id: entry.id, kind: message.kind })
      idx += 1
    }
  }

  /** Message `idx` as the Conversation's entry holds it now. */
  async #message(idx: number): Promise<LogMessage> {
    const row = loggedAt(this.#db, this.#chat, idx)
    if (row === undefined) throw new MemoryMissing({ what: 'message' })
    const id = entryId(row.entryId)
    const [entry] = (await (await this.#main()).entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND))
      .items
    const message = entry === undefined ? undefined : logMessage(entry)
    if (message === undefined) throw new MemoryMissing({ what: 'entry' })
    return message
  }

  /** Summarizes one node with the view lines before it as context, and stores it. */
  async #build(node: Node, sizes: Sizes, signal: AbortSignal): Promise<void> {
    const before = fold(firstOf(node), sizes).parts.slice(-CONTEXT_LINES)
    const texts = nodeTexts(this.#db, this.#chat, before)
    const context = before.flatMap((part) => texts.get(nodeKey(part)) ?? [])
    const step: Step =
      node.level === 0
        ? { kind: 'compress', message: messageLine(await this.#message(node.index)) }
        : this.#mergeStep(node)
    const text = await summarize(this.#deps.model, context, step, signal, this.#options.summaryPrompt)
    storeNode(this.#db, this.#chat, node, { text, bytes: byteLength(text) })
  }

  #mergeStep(node: Node): Step {
    const [a, b] = childrenOf(node)
    const texts = nodeTexts(this.#db, this.#chat, [a, b])
    const [first, second] = [texts.get(nodeKey(a)), texts.get(nodeKey(b))]
    if (first === undefined || second === undefined) throw new MemoryMissing({ what: 'summary' })
    return { kind: 'merge', lines: [first, second] }
  }

  /**
   * The write that places the view in main, its head at the newest input so the model sees the view and then
   * everything from that input on. A write submission, never a direct append: a busy Conversation places it at its
   * next boundary. The request id makes a repeated step write it once. None when the head message is gone.
   */
  #placement(parts: readonly Node[], bytes: number, through: number): Placement | undefined {
    const texts = nodeTexts(this.#db, this.#chat, parts)
    const lines = parts.flatMap((part) => {
      const text = texts.get(nodeKey(part))
      return text === undefined ? [] : [renderLine(part, text)]
    })
    const head = loggedAt(this.#db, this.#chat, through)
    if (head === undefined) return undefined
    const text = `<memory>\n${lines.join('\n')}\n</memory>`
    return {
      through,
      write: {
        requestId: `memory:${through}`,
        entry: {
          kind: 'app.memory',
          head: entryId(head.entryId),
          data: { through, bytes },
          model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }],
        },
      },
    }
  }
}
