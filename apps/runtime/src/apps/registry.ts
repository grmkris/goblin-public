import { type AgentAppLaunch, type AppLaunch, type AppView, MAIN_THREAD } from '@goblin/contracts'
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { NotFound } from '../http/errors.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
import type { AgentAppInfo } from '../agent-apps/engine.ts'
import { appConversations, appRegistry } from '../storage/schema.ts'

type Row = typeof appRegistry.$inferSelect

/** Where an App comes from: its server, the tool whose call it shows, the `ui://` resource it renders, its name. */
export type AppOrigin = {
  readonly serverId: string
  readonly tool: string
  readonly uri: string
  readonly title: string
}

/** An `mcp_call` in a transcript: the server and tool it called, its arguments and its committed (redacted) result. */
export type AppCall = {
  readonly entry: number
  readonly serverId: string
  readonly tool: string
  readonly arguments: Record<string, unknown>
  readonly result: unknown
}

/** An MCP App's row: one with its call, server, tool and resource (the table's CHECK holds them together). */
type McpRow = Row & {
  readonly callId: string
  readonly serverId: string
  readonly tool: string
  readonly resourceUri: string
}
const isMcp = (row: Row): row is McpRow =>
  row.source === 'mcp' && row.callId !== null && row.serverId !== null && row.tool !== null && row.resourceUri !== null

/** What the registry reads of the agent's apps (ADR 0021). */
export type AgentAppsPort = {
  /** An app's title and home, its release and number, its revision, whether it has a view, and its schedules. */
  readonly info: (name: string) => AgentAppInfo | undefined
  /** What the browser needs to load the app's view. */
  readonly launch: (name: string) => AgentAppLaunch
  /** Moves the home of every app that lives in one of `closed` to `to`. */
  readonly rehome: (closed: readonly string[], to: string) => void
}

const sourceOf = (row: Row, agents: AgentAppsPort): AppView['source'] => {
  if (isMcp(row))
    return { kind: 'mcp', callId: row.callId, serverId: row.serverId, tool: row.tool, uri: row.resourceUri }
  const name = row.name ?? ''
  const info = agents.info(name)
  if (info === undefined) throw new NotFound({ what: `agent app ${name}` })
  return { kind: 'agent', name, release: info.release, version: info.version, revision: info.revision, jobs: info.jobs }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The `mcp_call` with id `callId` among an assistant entry's tool calls, as server, tool and arguments. */
function mcpCallIn(entry: EntryRecord, callId: string) {
  const message = entry.model?.[0]
  if (message?.role !== 'assistant') return undefined
  const call = message.content.find((block) => block.type === 'toolCall' && block.id === callId)
  if (call?.type !== 'toolCall' || call.name !== 'mcp_call') return undefined
  const { serverId, name, arguments: args } = call.arguments
  if (typeof serverId !== 'string' || typeof name !== 'string') return undefined
  return { serverId, tool: name, arguments: isRecord(args) ? args : {} }
}

/** The details of the result of call `callId`, when `entry` is it. */
function resultIn(entry: EntryRecord, callId: string): { readonly details: unknown } | undefined {
  const message = entry.model?.[0]
  return message?.role === 'toolResult' && message.toolCallId === callId ? { details: message.details } : undefined
}

/** How far back a call is looked for, and how far after it its result. */
const SEARCH = 2000
const AFTER = 200

/**
 * The owner's Apps (ADRs 0020, 0021): an MCP App kept per tool call whose tool renders one, under the conversation it
 * was made in, and each agent app with a view, under its home conversation. Showing an App never needs this to grant
 * anything: an MCP App's resource and calls go through the owner's grants, live, every time, and an agent app's view
 * calls only its own actions. Closing a conversation closes its MCP Apps.
 */
export class AppRegistry {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #agents: AgentAppsPort
  readonly #listeners = new Set<(apps: readonly AppView[]) => void>()
  readonly #removals = new Set<(id: string) => void>()

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, agents: AgentAppsPort) {
    this.#db = db
    this.#harness = harness
    this.#agents = agents
  }

  /** Lightweight placement metadata for Home validation; unlike `list`, this never resolves an agent view. */
  placement(id: string): {
    readonly source: 'mcp' | 'agent'
    readonly closed: boolean
    readonly tool: string | null
    readonly title: string
  } {
    const row = this.#row(id)
    return { source: row.source, closed: row.closedAt !== null, tool: row.tool, title: row.title }
  }

  #view(row: Row): AppView {
    return {
      id: String(row.id),
      conversation: row.sessionId,
      title: row.title,
      createdAt: row.createdAt,
      ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
      source: sourceOf(row, this.#agents),
    }
  }

  /** Calls `listener` after each write with the Apps it changed; returns what unsubscribes it. */
  onChange(listener: (apps: readonly AppView[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Calls `listener` with the id of each App that is gone; returns what unsubscribes it. */
  onRemove(listener: (id: string) => void): () => void {
    this.#removals.add(listener)
    return () => this.#removals.delete(listener)
  }

  #changed(rows: readonly Row[]): void {
    if (rows.length > 0) for (const listener of this.#listeners) listener(rows.map((row) => this.#view(row)))
  }

  #row(id: string): Row {
    const row = /^\d{1,12}$/u.test(id)
      ? this.#db
          .select()
          .from(appRegistry)
          .where(eq(appRegistry.id, Number(id)))
          .get()
      : undefined
    if (row === undefined) throw new NotFound({ what: 'app' })
    return row
  }

  /** Keeps the App of call `callId` in `session`; the same call keeps the same App, opened again if it was closed. */
  register(session: string, callId: string, origin: AppOrigin, now: number): AppView {
    const [row] = this.#db
      .insert(appRegistry)
      .values({
        source: 'mcp',
        sessionId: session,
        callId,
        serverId: origin.serverId,
        tool: origin.tool,
        resourceUri: origin.uri,
        title: origin.title,
        createdAt: now,
      })
      .onConflictDoUpdate({ target: [appRegistry.sessionId, appRegistry.callId], set: { closedAt: null } })
      .returning()
      .all()
    if (row === undefined) throw new NotFound({ what: 'app' })
    this.#changed([row])
    return this.#view(row)
  }

  /**
   * An agent app changed (a build, a rollback, a new revision): the first release with a view shows it under its home
   * conversation, and every change after that goes to the feed with its release and revision.
   */
  agentChanged(name: string, now: number): void {
    const info = this.#agents.info(name)
    if (info === undefined) return
    const row = this.#db.select().from(appRegistry).where(eq(appRegistry.name, name)).get()
    if (row === undefined && !info.ui) return
    const [changed] =
      row === undefined
        ? this.#db
            .insert(appRegistry)
            .values({ source: 'agent', sessionId: info.home, name, title: info.title, createdAt: now })
            .returning()
            .all()
        : this.#db
            .update(appRegistry)
            .set({ title: info.title, sessionId: info.home })
            .where(eq(appRegistry.id, row.id))
            .returning()
            .all()
    if (changed !== undefined) this.#changed([changed])
  }

  /** The App id of an agent app with a view, or null. */
  agentId(name: string): string | null {
    const row = this.#db.select({ id: appRegistry.id }).from(appRegistry).where(eq(appRegistry.name, name)).get()
    return row === undefined ? null : String(row.id)
  }

  /** The owner deleted an agent app: its App goes from every pane and list. */
  removeAgent(name: string): void {
    const [row] = this.#db.delete(appRegistry).where(eq(appRegistry.name, name)).returning().all()
    if (row !== undefined) for (const listener of this.#removals) listener(String(row.id))
  }

  /**
   * Where an open App comes from, for what it shares with the owner's message: an MCP App's server, or the agent app
   * it is. A closed or unknown App shares nothing.
   */
  originOf(id: string, conversation: string): { readonly serverId: string } | { readonly app: string } {
    const row = this.#row(id)
    if (row.closedAt !== null || row.sessionId !== conversation) throw new NotFound({ what: 'app' })
    if (isMcp(row)) return { serverId: row.serverId }
    return { app: this.agentApp(id) }
  }

  /** The agent app an App id names. */
  agentApp(id: string): string {
    const row = this.#row(id)
    if (row.source !== 'agent' || row.name === null) throw new NotFound({ what: 'agent app' })
    return row.name
  }

  /** Every App, oldest first, closed ones included. */
  list(): readonly AppView[] {
    return this.#db
      .select()
      .from(appRegistry)
      .orderBy(asc(appRegistry.id))
      .all()
      .map((row) => this.#view(row))
  }

  /** Closes an App (it goes from every pane and transcript) or opens it again. */
  update(id: string, closed: boolean, now: number): AppView {
    const [row] = this.#db
      .update(appRegistry)
      .set({ closedAt: closed ? now : null })
      .where(eq(appRegistry.id, this.#row(id).id))
      .returning()
      .all()
    if (row === undefined) throw new NotFound({ what: 'app' })
    this.#changed([row])
    return this.#view(row)
  }

  /**
   * Closes the open MCP Apps of those of `sessions` that are closed now (Close reaches a conversation's Apps), and
   * moves the home of each agent app that lived in one to main: an agent app outlives its conversation.
   */
  closeWithConversations(sessions: readonly string[], now: number): void {
    if (sessions.length === 0) return
    const closed = this.#db
      .select({ id: appConversations.sessionId })
      .from(appConversations)
      .where(and(inArray(appConversations.sessionId, [...sessions]), isNotNull(appConversations.closedAt)))
      .all()
      .map((row) => row.id)
    if (closed.length === 0) return
    const rows = this.#db
      .update(appRegistry)
      .set({ closedAt: now })
      .where(and(eq(appRegistry.source, 'mcp'), isNull(appRegistry.closedAt), inArray(appRegistry.sessionId, closed)))
      .returning()
      .all()
    this.#changed(rows)
    this.#agents.rehome(closed, MAIN_THREAD)
  }

  /** What the browser needs to load an App: an MCP App's call, read from its conversation, or an agent app's view. */
  async launch(id: string): Promise<AppLaunch> {
    const row = this.#row(id)
    if (!isMcp(row)) return this.#agents.launch(this.agentApp(id))
    const call = await this.call(row.sessionId, row.callId, row.entryId ?? undefined)
    if (row.entryId === null)
      this.#db.update(appRegistry).set({ entryId: call.entry }).where(eq(appRegistry.id, row.id)).run()
    return { kind: 'mcp', serverId: row.serverId, uri: row.resourceUri, arguments: call.arguments, result: call.result }
  }

  /**
   * The `mcp_call` with id `callId` in `session` and its committed result: from `at` when it is known, otherwise
   * searched back from the newest entry. `NotFound` when it is not there or has no result yet.
   */
  async call(session: string, callId: string, at?: number): Promise<AppCall> {
    const conversation = await (await this.#harness.pi()).conversation(conversationId(session), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'conversation' })
    const entry = at ?? (await this.#find(session, callId))
    const page = await conversation.entries(
      { minEntryId: entryId(entry), maxEntryId: entryId(entry + AFTER) },
      AFTER + 1,
      undefined,
      BACKGROUND,
    )
    const asked = page.items.find((item) => item.id === entry)
    const made = asked === undefined ? undefined : mcpCallIn(asked, callId)
    const result = page.items.map((item) => resultIn(item, callId)).find((found) => found !== undefined)
    if (made === undefined || result === undefined) throw new NotFound({ what: 'app call' })
    return { entry, ...made, result: result.details }
  }

  /** The entry that made call `callId`, among the newest of `session`. */
  async #find(session: string, callId: string): Promise<number> {
    const conversation = await (await this.#harness.pi()).conversation(conversationId(session), BACKGROUND)
    if (conversation === undefined) throw new NotFound({ what: 'conversation' })
    let cursor: Parameters<typeof conversation.entries>[2]
    for (let seen = 0; seen < SEARCH;) {
      const page = await conversation.entries({}, 100, cursor, BACKGROUND)
      const found = page.items.find((item) => mcpCallIn(item, callId) !== undefined)
      if (found !== undefined) return found.id
      seen += page.items.length
      if (page.next === undefined) break
      cursor = page.next
    }
    throw new NotFound({ what: 'app call' })
  }
}
