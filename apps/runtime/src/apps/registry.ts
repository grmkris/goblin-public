import type { AppLaunch, AppView } from '@goblin/contracts'
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { NotFound } from '../http/errors.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'
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

/** An agent app as the registry shows it: the release it runs, its number, and its state's revision (ADR 0021). */
export type AgentAppInfo = { readonly release: string; readonly version: number; readonly revision: number }

const sourceOf = (row: Row, agents: (name: string) => AgentAppInfo | undefined): AppView['source'] => {
  if (isMcp(row))
    return { kind: 'mcp', callId: row.callId, serverId: row.serverId, tool: row.tool, uri: row.resourceUri }
  const name = row.name ?? ''
  const info = agents(name)
  if (info === undefined) throw new NotFound({ what: `agent app ${name}` })
  return { kind: 'agent', name, ...info }
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
 * The owner's MCP Apps, kept (ADR 0020): one per tool call whose tool renders an App, under the conversation it was
 * made in. Showing an App never needs this to grant anything: the App's resource and its calls go through the owner's
 * grants, live, every time. Closing a conversation closes its Apps.
 */
export class AppRegistry {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #agents: (name: string) => AgentAppInfo | undefined
  readonly #listeners = new Set<(apps: readonly AppView[]) => void>()

  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, agents: (name: string) => AgentAppInfo | undefined) {
    this.#db = db
    this.#harness = harness
    this.#agents = agents
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

  /** Closes the open Apps of those of `sessions` that are closed now: Close reaches a conversation's Apps. */
  closeWithConversations(sessions: readonly string[], now: number): void {
    if (sessions.length === 0) return
    const closed = this.#db
      .select({ id: appConversations.sessionId })
      .from(appConversations)
      .where(and(inArray(appConversations.sessionId, [...sessions]), isNotNull(appConversations.closedAt)))
    const rows = this.#db
      .update(appRegistry)
      .set({ closedAt: now })
      .where(and(eq(appRegistry.source, 'mcp'), isNull(appRegistry.closedAt), inArray(appRegistry.sessionId, closed)))
      .returning()
      .all()
    this.#changed(rows)
  }

  /** The call an App shows, read from its conversation: what the browser needs to load it. */
  async launch(id: string): Promise<AppLaunch> {
    const row = this.#row(id)
    if (!isMcp(row)) throw new NotFound({ what: 'app' })
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
