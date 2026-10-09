import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  type CapabilityTarget,
  type ConversationKind,
  type HelperExclusion,
  RoutineDefinition,
} from '@goblin/contracts'
import { and, eq, inArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import {
  appConversationCapabilities,
  appExecutionExclusions,
  appConversations,
  appChannel,
  appMetadata,
  appTelegramChannel,
} from '../storage/schema.ts'
import { appRoutineRuns } from '../storage/routines.ts'
import * as Schema from 'effect/Schema'
import type { ChatDirectory } from '../chats/directory.ts'
import { InvalidInput } from '../http/errors.ts'

type Kind = CapabilityTarget['kind']

/** A conversation's Pi tool filter: the subagent tools removed, or none (`null` clears an inherited one). */
export type PiTools = { readonly remove: readonly ToolRegistration[] } | null

/** One thing switched off in a conversation, as stored: `serverId` empty for subagents, `name` set only for a tool. */
export type Exclusion = { readonly kind: Kind; readonly serverId: string; readonly name: string }

/**
 * What a conversation's agent may use, after its switches: the one gate every tool and section asks. It only narrows
 * the owner's grants, which the MCP manager still checks. `editable`: the owner can switch things here (not in a
 * subagent, which follows the conversations above it).
 */
export type CapabilityScope = {
  readonly editable: boolean
  readonly server: (serverId: string) => boolean
  /** A tool is off when it or its server is. */
  readonly tool: (serverId: string, name: string) => boolean
  readonly skills: (serverId: string) => boolean
  readonly subagents: () => boolean
}

/** A conversation this registry does not know may use nothing. */
export const CLOSED: CapabilityScope = {
  editable: false,
  server: () => false,
  tool: () => false,
  skills: () => false,
  subagents: () => false,
}

const key = ({ kind, serverId, name }: Exclusion) => `${kind}\n${serverId}\n${name}`

/** The stored row for a target. */
export const exclusionOf = (target: CapabilityTarget): Exclusion => ({
  kind: target.kind,
  serverId: target.kind === 'subagents' ? '' : target.serverId,
  name: target.kind === 'tool' ? target.name : '',
})

/** The scope that switches off everything in `exclusions` (the rows of a conversation and those above it). */
export function scopeOf(exclusions: readonly Exclusion[], editable: boolean): CapabilityScope {
  const off = new Set(exclusions.map(key))
  const server = (serverId: string) => !off.has(key({ kind: 'server', serverId, name: '' }))
  return {
    editable,
    server,
    tool: (serverId, name) => server(serverId) && !off.has(key({ kind: 'tool', serverId, name })),
    skills: (serverId) => !off.has(key({ kind: 'skills', serverId, name: '' })),
    subagents: () => !off.has(key({ kind: 'subagents', serverId: '', name: '' })),
  }
}

/** Whether two conversations switched off exactly the same things. */
export const sameExclusions = (one: readonly Exclusion[], other: readonly Exclusion[]): boolean => {
  const keys = new Set(one.map(key))
  return keys.size === new Set(other.map(key)).size && other.every((exclusion) => keys.has(key(exclusion)))
}

/** One conversation in a chain of spawners. */
type Link = { readonly session: string; readonly kind: ConversationKind; readonly routineRunId: string | null }

/** Rows per insert: five bound values each, under SQLite's limit of 100 per statement on Cloudflare. */
const INSERT_ROWS = 20

/** Called inside a short application transaction, including the first registration of a helper. */
export function writeHelperExclusions(
  db: DrizzleSqliteDODatabase,
  session: string,
  exclusions: readonly HelperExclusion[],
  now: number,
): void {
  db.delete(appConversationCapabilities).where(eq(appConversationCapabilities.sessionId, session)).run()
  db.delete(appExecutionExclusions).where(eq(appExecutionExclusions.sessionId, session)).run()
  for (const target of exclusions) {
    if (target.kind === 'app') {
      db.insert(appExecutionExclusions)
        .values({ sessionId: session, app: target.app, offAt: now })
        .onConflictDoNothing()
        .run()
    } else {
      db.insert(appConversationCapabilities)
        .values({ sessionId: session, ...exclusionOf(target), offAt: now })
        .onConflictDoNothing()
        .run()
    }
  }
}

/**
 * Each conversation's switches (`app_conversation_capabilities`): only what is off is stored, so a tool granted later is
 * on everywhere until switched off. A thread copies the switches of the conversation it came from when it is created. A
 * subagent may store its parent's exclusions too: it is bounded by every conversation above it, read live, so it can never do more than the one
 * that started it.
 * `subagentTools` are what Pi's per-conversation tool filter removes when subagents are off; `retool` applies that
 * filter to a conversation in Pi (outside any SQLite transaction).
 */
export class CapabilityProfiles {
  readonly #db: DrizzleSqliteDODatabase
  readonly #chats: ChatDirectory
  readonly #subagentTools: readonly ToolRegistration[]
  readonly #retool: (session: string, tools: PiTools) => Promise<void>

  constructor(
    db: DrizzleSqliteDODatabase,
    subagentTools: readonly ToolRegistration[],
    retool: (session: string, tools: PiTools) => Promise<void>,
    chats: ChatDirectory,
  ) {
    this.#db = db
    this.#chats = chats
    this.#subagentTools = subagentTools
    this.#retool = retool
  }

  /** What `session` switched off itself. */
  own(session: string): readonly Exclusion[] {
    return this.#db
      .select({
        kind: appConversationCapabilities.kind,
        serverId: appConversationCapabilities.serverId,
        name: appConversationCapabilities.name,
      })
      .from(appConversationCapabilities)
      .where(eq(appConversationCapabilities.sessionId, session))
      .all()
  }

  #conversation(session: string) {
    return this.#db
      .select({
        kind: appConversations.kind,
        parent: appConversations.parentSession,
        routineRunId: appConversations.routineRunId,
      })
      .from(appConversations)
      .where(eq(appConversations.chatId, session))
      .get()
  }

  /**
   * The conversations whose switches bound `session`: it, then each spawner while that is a subagent, up to the first
   * conversation that is not (whose own switches are whole). Subagents nest without a depth limit; a conversation seen
   * twice or a subagent without a spawner breaks the chain (`undefined`), and a broken chain may use nothing.
   */
  #chain(session: string) {
    const chain: Link[] = []
    const seen = new Set<string>()
    for (let at: string | null = session; at !== null && !seen.has(at);) {
      const row = this.#conversation(at)
      if (row === undefined) return undefined
      seen.add(at)
      chain.push({ session: at, kind: row.kind, routineRunId: row.routineRunId })
      if (row.kind !== 'subagent') return chain
      at = row.parent
    }
    return undefined
  }

  /** What `session` works without: its own switches and, for a subagent, those of every spawner above it. */
  #effective(session: string): readonly Exclusion[] | undefined {
    return this.#chain(session)?.flatMap((link) => this.own(link.session))
  }

  /** The scope of a registered conversation: its own switches, and for a subagent those of every spawner above it. */
  scope(session: string): CapabilityScope {
    const chat = this.#chats.chatOf(session)
    const chain = chat === undefined ? undefined : this.#chain(chat)
    const start = chain?.[0]
    const root = chain?.at(-1)
    if (chain === undefined || start === undefined || root === undefined) return CLOSED
    const scope = scopeOf(
      chain.flatMap((link) => this.own(link.session)),
      start.kind !== 'subagent' && start.routineRunId === null,
    )
    return root.routineRunId === null ? scope : this.#routine(scope, root.routineRunId)
  }

  /** App calls follow the same live chain as MCP and skills; routine scopes do not acquire app powers. */
  app(session: string, app: string): boolean {
    const chat = this.#chats.chatOf(session)
    const chain = chat === undefined ? undefined : this.#chain(chat)
    if (chain === undefined || chain.some((link) => link.routineRunId !== null)) return false
    return !this.#db
      .select()
      .from(appExecutionExclusions)
      .where(
        and(
          inArray(
            appExecutionExclusions.sessionId,
            chain.map((link) => link.session),
          ),
          eq(appExecutionExclusions.app, app),
        ),
      )
      .get()
  }

  /** Only the direct parent can configure a registered helper. Exclusions cannot widen any ancestor's ceiling. */
  async configureHelper(
    parent: string,
    session: string,
    exclusions: readonly HelperExclusion[],
    now: number,
  ): Promise<void> {
    const chat = this.#chats.chatOf(session)
    const parentChat = this.#chats.chatOf(parent)
    const row = chat === undefined ? undefined : this.#conversation(chat)
    if (chat === undefined || parentChat === undefined || row?.kind !== 'subagent' || row.parent !== parentChat)
      throw new InvalidInput({ reason: 'helper_parent' })
    this.#db.transaction(() => writeHelperExclusions(this.#db, chat, exclusions, now))
    await this.syncPi(chat)
  }

  /** A routine's thread may use only the tools its definition allows, within the scope it would have anyway. */
  #routine(scope: CapabilityScope, runId: string): CapabilityScope {
    const run = this.#db.select().from(appRoutineRuns).where(eq(appRoutineRuns.id, runId)).get()
    if (run === undefined) return CLOSED
    const definition = Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(run.definitionJson))
    const channel = this.#db.select().from(appTelegramChannel).get() ?? this.#db.select().from(appChannel).get()
    return {
      editable: false,
      server: (id) => scope.server(id) && definition.allowedTools.some((tool) => tool.serverId === id),
      tool: (id, name) =>
        scope.tool(id, name) &&
        (definition.notifyTelegram || channel?.serverId !== id || name !== 'send_message') &&
        definition.allowedTools.some((tool) => tool.serverId === id && tool.name === name),
      skills: () => false,
      subagents: () => false,
    }
  }

  /** Switch one thing on or off in `session`. A server switched back on keeps the tools switched off under it. */
  set(session: string, target: CapabilityTarget, on: boolean, now: number): void {
    const { kind, serverId, name } = exclusionOf(target)
    const table = appConversationCapabilities
    if (on)
      this.#db
        .delete(table)
        .where(
          and(eq(table.sessionId, session), eq(table.kind, kind), eq(table.serverId, serverId), eq(table.name, name)),
        )
        .run()
    else
      this.#db
        .insert(table)
        .values({ sessionId: session, kind, serverId, name, offAt: now })
        .onConflictDoNothing()
        .run()
  }

  /**
   * Give `to` exactly the switches `from` works under (a new thread copies its parent's; Reset copies them again). From
   * a subagent that is its spawners' switches, since it stores none of its own.
   */
  copy(from: string, to: string, now: number): void {
    const rows = (this.#effective(from) ?? this.own(from)).map((exclusion) => ({
      ...exclusion,
      sessionId: to,
      offAt: now,
    }))
    this.#db.transaction((tx) => {
      tx.delete(appConversationCapabilities).where(eq(appConversationCapabilities.sessionId, to)).run()
      const chain = this.#chain(from)
      const apps =
        chain === undefined
          ? []
          : tx
              .select()
              .from(appExecutionExclusions)
              .where(
                inArray(
                  appExecutionExclusions.sessionId,
                  chain.map((link) => link.session),
                ),
              )
              .all()
      tx.delete(appExecutionExclusions).where(eq(appExecutionExclusions.sessionId, to)).run()
      for (const row of apps)
        tx.insert(appExecutionExclusions)
          .values({ sessionId: to, app: row.app, offAt: now })
          .onConflictDoNothing()
          .run()
      for (let start = 0; start < rows.length; start += INSERT_ROWS)
        tx.insert(appConversationCapabilities)
          .values(rows.slice(start, start + INSERT_ROWS))
          .onConflictDoNothing()
          .run()
    })
  }

  /** What Reset gives `thread`: the switches of the conversation it came from (main's for a thread started empty). */
  inherited(thread: string): readonly Exclusion[] {
    return this.#effective(this.#conversation(thread)?.parent ?? this.#chats.primary()) ?? []
  }

  /** A thread's switches back to those of the conversation it came from, applied to Pi too. */
  async reset(thread: string, now: number): Promise<void> {
    this.copy(this.#conversation(thread)?.parent ?? this.#chats.primary(), thread, now)
    await this.syncPi(thread)
  }

  /** Pi's tool filter for `session`: without the subagent tools when subagents are off where it works, else none. */
  piTools(session: string): PiTools {
    const effective = this.#effective(session)
    return effective !== undefined && scopeOf(effective, true).subagents() ? null : { remove: this.#subagentTools }
  }

  /** Applies `session`'s tool filter to its Pi conversation, after the switches are stored. */
  async syncPi(session: string): Promise<void> {
    await this.#retool(this.#chats.session(session), this.piTools(session))
  }

  /**
   * Applies every filtering conversation's tool filter to Pi again, once per `marker`. Pi keeps a filter as tool
   * names, so one stored before the tools it names changed (`subagent` became the `subagent_*` tools) removes nothing
   * until it is applied again. The marker is written after every conversation is done, so a failure retries them all.
   */
  async retoolOnce(marker: string, now: number): Promise<void> {
    if (this.#db.select().from(appMetadata).where(eq(appMetadata.id, marker)).get() !== undefined) return
    // Registered conversations only: one not registered yet (a new agent's main) has no switches to apply.
    for (const { session } of this.#db.select({ session: appConversations.chatId }).from(appConversations).all()) {
      const tools = this.piTools(session)
      if (tools !== null) await this.#retool(this.#chats.session(session), tools)
    }
    this.#db
      .insert(appMetadata)
      .values({ id: marker, value: String(now) })
      .onConflictDoNothing()
      .run()
  }
}
