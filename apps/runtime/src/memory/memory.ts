import { type Conversation, type EntryRecord, type Extension, type Tx } from '@earendil-works/pi-durable'
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import type { PiHarness } from 'agents/harness/pi'
import { and, count, desc, eq, inArray, lte } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { ChatDirectory } from '../chats/directory.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import { appMemoryLog, appMemoryNodes, appMemoryState } from '../storage/schema.ts'
import { type LogMessage, logMessage, messageLine } from './log.ts'
import type { TextCompletion } from './model.ts'
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

/** What one builder step did: there is more to build, or the memory has caught up. */
export type StepResult = 'more' | 'done'

/**
 * Main's memory, after OptChat: every message of main from activation on is logged, summarized into a binary tree of
 * one-line summaries by the cheap model, and folded into a view of `VIEW_BYTES`. The view is written into main as an
 * `app.memory` entry whose head is main's newest input, the way Pi places a compaction: the model then sees the view
 * and, verbatim, everything from that input on. Nothing waits for the summarizer: until a message is summarized it is
 * simply still shown in full. The builder task (`pi/memory.ts`) drives `step`; `zoom` opens a line.
 */
export class MainMemory {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #model: TextCompletion
  readonly #chats: ChatDirectory
  readonly #options: MemoryOptions

  constructor(
    db: DrizzleSqliteDODatabase,
    harness: PiHarness,
    model: TextCompletion,
    options: MemoryOptions = {},
    chats: ChatDirectory,
  ) {
    this.#db = db
    this.#harness = harness
    this.#model = model
    this.#options = options
    this.#chats = chats
  }

  async #main(): Promise<Conversation> {
    const main = await (
      await this.#harness.pi()
    ).conversation(conversationId(this.#chats.session(this.#chats.primary())), BACKGROUND)
    if (main === undefined) throw new Error('The main conversation is missing')
    return main
  }

  #state() {
    return this.#db.select().from(appMemoryState).where(eq(appMemoryState.id, 1)).get()
  }

  /**
   * Turns the memory on, once: main gets `extensions` (the builder and `zoom`), and every message after main's newest
   * entry is remembered. Older history stays in Pi, unseen by the model once the first view lands.
   */
  async activate(extensions: readonly Extension[]): Promise<void> {
    if (this.#state() !== undefined) return
    const main = await this.#main()
    const [newest] = (await main.entries({}, 1, undefined, BACKGROUND)).items
    await main.configure({ extensions: { add: extensions } }, BACKGROUND)
    this.#db
      .insert(appMemoryState)
      .values({ id: 1, originEntry: newest?.id ?? 0, viewThrough: 0 })
      .onConflictDoNothing()
      .run()
  }

  /** Starts the builder unless one runs: `start` runs in a commit on main, where the builder's record lives. */
  async startBuilder(start: (tx: Tx) => Promise<void>): Promise<void> {
    await (await this.#main()).commit(start, BACKGROUND)
  }

  /** Messages remembered so far. */
  size(): number {
    return this.#db.select({ n: count() }).from(appMemoryLog).get()?.n ?? 0
  }

  /** Messages remembered up to and including main's entry `entry`: what a thread branched there may zoom into. */
  sizeAt(entry: number): number {
    return this.#db.select({ n: count() }).from(appMemoryLog).where(lte(appMemoryLog.entryId, entry)).get()?.n ?? 0
  }

  /** How far the newest view reaches, in messages. */
  viewThrough(): number {
    return this.#state()?.viewThrough ?? 0
  }

  /**
   * One unit of work: log main's new entries, then summarize the first message not summarized yet, else build the
   * merge the view waits for, else place a view that reaches further than the last one, once main has run far enough
   * past the last one ({@link FOLD_TOKENS}).
   */
  async step(signal: AbortSignal): Promise<StepResult> {
    await this.#collect()
    const total = this.size()
    const sizes = this.#sizes()
    const leaves = [...sizes.keys()].filter((key) => key.startsWith('0:')).length
    if (leaves < total) {
      await this.#build({ level: 0, index: leaves }, sizes, signal)
      return 'more'
    }
    const through = this.#newestInput()
    if (through === undefined || through === 0) return 'done'
    const view = fold(through, sizes, this.#options.viewBytes ?? VIEW_BYTES)
    if (view.wanted !== undefined) {
      await this.#build(view.wanted, sizes, signal)
      return 'more'
    }
    if (through > this.viewThrough() && (await this.#pastFold())) await this.#place(view.parts, view.bytes, through)
    return 'done'
  }

  /**
   * Whether what the model reads verbatim after the current view (from its head, or from activation before the first
   * view) is past the fold threshold. Reads main newest first and stops as soon as it is.
   */
  async #pastFold(): Promise<boolean> {
    const limit = this.#options.foldTokens ?? FOLD_TOKENS
    const state = this.#state()
    if (limit <= 0 || state === undefined) return true
    const head =
      state.viewThrough === 0
        ? undefined
        : this.#db.select().from(appMemoryLog).where(eq(appMemoryLog.idx, state.viewThrough)).get()
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
    const texts = this.#texts(children)
    const lines = children.map((child) => {
      const text = texts.get(nodeKey(child))
      return text === undefined ? undefined : renderLine(child, text)
    })
    return lines.every((line) => line !== undefined) ? lines.join('\n') : missing
  }

  /** Adds main's entries since the last remembered one, oldest first. */
  async #collect(): Promise<void> {
    const state = this.#state()
    if (state === undefined) return
    const last = this.#db.select().from(appMemoryLog).orderBy(desc(appMemoryLog.idx)).limit(1).get()
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
    for (const entry of fresh.toReversed()) {
      const message = logMessage(entry)
      if (message === undefined) continue
      this.#db.insert(appMemoryLog).values({ idx, entryId: entry.id, kind: message.kind }).run()
      idx += 1
    }
  }

  /** The newest message from someone other than the agent: the view reaches up to it, and it stays verbatim. */
  #newestInput(): number | undefined {
    return this.#db
      .select({ idx: appMemoryLog.idx })
      .from(appMemoryLog)
      .where(eq(appMemoryLog.kind, 'user'))
      .orderBy(desc(appMemoryLog.idx))
      .limit(1)
      .get()?.idx
  }

  /** The text bytes of every built node: all the fold needs. */
  #sizes(): Map<string, number> {
    const rows = this.#db
      .select({ level: appMemoryNodes.level, idx: appMemoryNodes.idx, bytes: appMemoryNodes.bytes })
      .from(appMemoryNodes)
      .all()
    return new Map(rows.map((row) => [nodeKey({ level: row.level, index: row.idx }), row.bytes]))
  }

  #texts(nodes: readonly Node[]): Map<string, string> {
    const texts = new Map<string, string>()
    for (const level of new Set(nodes.map((node) => node.level))) {
      const indexes = nodes.filter((node) => node.level === level).map((node) => node.index)
      const rows = this.#db
        .select()
        .from(appMemoryNodes)
        .where(and(eq(appMemoryNodes.level, level), inArray(appMemoryNodes.idx, indexes)))
        .all()
      for (const row of rows) texts.set(nodeKey({ level: row.level, index: row.idx }), row.text)
    }
    return texts
  }

  /** Message `idx` as main's entry holds it now. */
  async #message(idx: number): Promise<LogMessage> {
    const row = this.#db.select().from(appMemoryLog).where(eq(appMemoryLog.idx, idx)).get()
    if (row === undefined) throw new Error(`Memory message ${idx} is missing`)
    const id = entryId(row.entryId)
    const [entry] = (await (await this.#main()).entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND))
      .items
    const message = entry === undefined ? undefined : logMessage(entry)
    if (message === undefined) throw new Error(`Memory message ${idx} has no entry`)
    return message
  }

  /** Summarizes one node with the view lines before it as context, and stores it. */
  async #build(node: Node, sizes: Sizes, signal: AbortSignal): Promise<void> {
    const before = fold(firstOf(node), sizes).parts.slice(-CONTEXT_LINES)
    const texts = this.#texts(before)
    const context = before.flatMap((part) => texts.get(nodeKey(part)) ?? [])
    const step: Step =
      node.level === 0
        ? { kind: 'compress', message: messageLine(await this.#message(node.index)) }
        : this.#mergeStep(node)
    const text = await summarize(this.#model, context, step, signal, this.#options.summaryPrompt)
    this.#db
      .insert(appMemoryNodes)
      .values({ level: node.level, idx: node.index, text, bytes: byteLength(text) })
      .onConflictDoNothing()
      .run()
  }

  #mergeStep(node: Node): Step {
    const [a, b] = childrenOf(node)
    const texts = this.#texts([a, b])
    const [first, second] = [texts.get(nodeKey(a)), texts.get(nodeKey(b))]
    if (first === undefined || second === undefined) throw new Error(`Memory node ${nodeKey(node)} lacks a child`)
    return { kind: 'merge', lines: [first, second] }
  }

  /**
   * Writes the view into main, its head at the newest input so the model sees the view and then everything from that
   * input on. A write submission, never a direct append: a busy main places it at its next boundary. The request id
   * makes a repeated step write it once.
   */
  async #place(parts: readonly Node[], bytes: number, through: number): Promise<void> {
    const texts = this.#texts(parts)
    const lines = parts.flatMap((part) => {
      const text = texts.get(nodeKey(part))
      return text === undefined ? [] : [renderLine(part, text)]
    })
    const head = this.#db.select().from(appMemoryLog).where(eq(appMemoryLog.idx, through)).get()
    if (head === undefined) return
    const text = `<memory>\n${lines.join('\n')}\n</memory>`
    await (
      await this.#main()
    ).submit(
      {
        type: 'write',
        requestId: `memory:${through}`,
        entry: {
          kind: 'app.memory',
          head: entryId(head.entryId),
          data: { through, bytes },
          model: [{ role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() }],
        },
      },
      BACKGROUND,
    )
    this.#db.update(appMemoryState).set({ viewThrough: through }).where(eq(appMemoryState.id, 1)).run()
  }
}
