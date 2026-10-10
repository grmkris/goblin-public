import { type AgentAppLaunch, type AppView } from '@goblin/contracts'
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { SQLiteAsyncDatabase } from 'drizzle-orm/sqlite-core/async/db'
import type { EntryRecord } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import type { ChatDirectory } from '../chats/directory.ts'
import { type AppError, NotFound, attempt, toAppError } from '../http/errors.ts'
import { BACKGROUND, entryId } from '../pi/context.ts'
import type { PiSessions } from '../pi/sessions.ts'
import type { AgentAppInfo } from '../agent-apps/engine.ts'
import { appConversations, appRegistry } from '../storage/schema.ts'
import { isRecord } from '../runtime/digest.ts'
import type { AppPlacement, AppSharing } from './service.ts'

type Row = typeof appRegistry.$inferSelect

/** The agent's synchronous SQLite. */
type AppsDb<RunResult> = SQLiteAsyncDatabase<'sync', RunResult>

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

/** Where a chat sits, as the registry reads it: a session's chat, a chat's session and the Conversation above it. */
export type ChatPlaces = Pick<ChatDirectory, 'chatOf' | 'session' | 'conversationAbove'>

/** What the registry's writes read besides the database: the agent's apps and where each chat sits. */
export type AppSources = { readonly agents: AgentAppsPort; readonly chats: ChatPlaces }

/*
 * The owner's Apps (ADRs 0020, 0021), as rows: an MCP App kept per tool call whose tool renders one, under the
 * conversation it was made in, and each agent app with a view, under its home conversation. Showing an App never
 * needs this to grant anything: an MCP App's resource and calls go through the owner's grants, live, every time, and an
 * agent app's view calls only its own actions. Closing a conversation closes its MCP Apps. The functions keep no state;
 * the `Apps` service (layers/apps.ts) tells the change bus what each write changed.
 */

const sourceOf = (row: Row, agents: AgentAppsPort): AppView['source'] => {
  if (isMcp(row))
    return { kind: 'mcp', callId: row.callId, serverId: row.serverId, tool: row.tool, uri: row.resourceUri }
  const name = row.name ?? ''
  const info = agents.info(name)
  if (info === undefined) throw new NotFound({ what: `agent app ${name}` })
  return { kind: 'agent', name, release: info.release, version: info.version, revision: info.revision, jobs: info.jobs }
}

const viewOf = (row: Row, agents: AgentAppsPort): AppView => ({
  id: String(row.id),
  conversation: row.chatId ?? row.sessionId,
  title: row.title,
  createdAt: row.createdAt,
  ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
  source: sourceOf(row, agents),
})

function rowOf<RunResult>(db: AppsDb<RunResult>, id: string): Row {
  const row = /^\d{1,12}$/u.test(id)
    ? db
        .select()
        .from(appRegistry)
        .where(eq(appRegistry.id, Number(id)))
        .get()
    : undefined
  if (row === undefined) throw new NotFound({ what: 'app' })
  return row
}

/** Lightweight placement metadata for Home validation; unlike `appList`, this never resolves an agent view. */
export function appPlacement<RunResult>(db: AppsDb<RunResult>, id: string): AppPlacement {
  const row = rowOf(db, id)
  return { source: row.source, closed: row.closedAt !== null, tool: row.tool, title: row.title }
}

/** One App as it is now; `NotFound` when there is none. */
export function appView<RunResult>(db: AppsDb<RunResult>, agents: AgentAppsPort, id: string): AppView {
  return viewOf(rowOf(db, id), agents)
}

/** Every App, oldest first, closed ones included. */
export function appList<RunResult>(db: AppsDb<RunResult>, agents: AgentAppsPort): readonly AppView[] {
  return db
    .select()
    .from(appRegistry)
    .orderBy(asc(appRegistry.id))
    .all()
    .map((row) => viewOf(row, agents))
}

/** One tool call's App to keep: the session and call it shows, and where it comes from. */
export type KeptApp = { readonly session: string; readonly callId: string; readonly origin: AppOrigin }

/** Keeps the App of call `callId` in `session`; the same call keeps the same App, opened again if it was closed. */
export function keepApp<RunResult>(
  db: AppsDb<RunResult>,
  { agents, chats }: AppSources,
  { session, callId, origin }: KeptApp,
  now: number,
): AppView {
  const [row] = db
    .insert(appRegistry)
    .values({
      source: 'mcp',
      sessionId: session,
      chatId: chats.chatOf(session) ?? session,
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
  return viewOf(row, agents)
}

/**
 * An agent app changed (a build, a rollback, a new revision): the first release with a view shows it under its home
 * conversation, and every change after that is a change of its App (with its release and revision). Answers the ids
 * of the Apps it changed.
 */
export function agentAppChanged<RunResult>(
  db: AppsDb<RunResult>,
  { agents, chats }: AppSources,
  name: string,
  now: number,
): readonly string[] {
  const info = agents.info(name)
  if (info === undefined) return []
  const home = chats.chatOf(info.home) ?? info.home
  const row = db.select().from(appRegistry).where(eq(appRegistry.name, name)).get()
  if (row === undefined && !info.ui) return []
  const [changed] =
    row === undefined
      ? db
          .insert(appRegistry)
          .values({ source: 'agent', sessionId: info.home, chatId: home, name, title: info.title, createdAt: now })
          .returning()
          .all()
      : db
          .update(appRegistry)
          .set({ title: info.title, sessionId: info.home, chatId: home })
          .where(eq(appRegistry.id, row.id))
          .returning()
          .all()
  return changed === undefined ? [] : [String(changed.id)]
}

/** The App id of an agent app with a view, or null. */
export function agentAppId<RunResult>(db: AppsDb<RunResult>, name: string): string | null {
  const row = db.select({ id: appRegistry.id }).from(appRegistry).where(eq(appRegistry.name, name)).get()
  return row === undefined ? null : String(row.id)
}

/** The owner deleted an agent app: its App goes from every pane and list. Answers the App's id, if it had one. */
export function removeAgentApp<RunResult>(db: AppsDb<RunResult>, name: string): string | undefined {
  const [row] = db.delete(appRegistry).where(eq(appRegistry.name, name)).returning().all()
  return row === undefined ? undefined : String(row.id)
}

/** The agent app an App id names. */
export function agentAppName<RunResult>(db: AppsDb<RunResult>, id: string): string {
  const row = rowOf(db, id)
  if (row.source !== 'agent' || row.name === null) throw new NotFound({ what: 'agent app' })
  return row.name
}

/**
 * Where an open App comes from, for what it shares with the owner's message: an MCP App's server, or the agent app
 * it is. A closed or unknown App shares nothing.
 */
export function appOrigin<RunResult>(db: AppsDb<RunResult>, id: string, conversation: string): AppSharing {
  const row = rowOf(db, id)
  if (row.closedAt !== null || (row.chatId ?? row.sessionId) !== conversation) throw new NotFound({ what: 'app' })
  if (isMcp(row)) return { serverId: row.serverId }
  return { app: agentAppName(db, id) }
}

/** Closes an App (it goes from every pane and transcript) or opens it again. */
export function setAppClosed<RunResult>(
  db: AppsDb<RunResult>,
  agents: AgentAppsPort,
  id: string,
  closed: boolean,
  now: number,
): AppView {
  const [row] = db
    .update(appRegistry)
    .set({ closedAt: closed ? now : null })
    .where(eq(appRegistry.id, rowOf(db, id).id))
    .returning()
    .all()
  if (row === undefined) throw new NotFound({ what: 'app' })
  return viewOf(row, agents)
}

/**
 * Closes the open MCP Apps of those of `sessions` that are closed now (Close reaches a conversation's Apps), and
 * moves the home of each agent app that lived in one to its Topic's Conversation: an agent app outlives its
 * conversation. Answers the ids of the Apps it closed.
 */
export function closeWithConversations<RunResult>(
  db: AppsDb<RunResult>,
  { agents, chats }: AppSources,
  sessions: readonly string[],
  now: number,
): readonly string[] {
  if (sessions.length === 0) return []
  const closed = db
    .select({ id: appConversations.chatId })
    .from(appConversations)
    .where(and(inArray(appConversations.chatId, [...sessions]), isNotNull(appConversations.closedAt)))
    .all()
    .map((row) => row.id)
  if (closed.length === 0) return []
  const rows = db
    .update(appRegistry)
    .set({ closedAt: now })
    .where(and(eq(appRegistry.source, 'mcp'), isNull(appRegistry.closedAt), inArray(appRegistry.chatId, closed)))
    .returning()
    .all()
  const homes = new Map<string, string[]>()
  for (const chat of closed) {
    const to = chats.conversationAbove(chat)
    homes.set(to, [...(homes.get(to) ?? []), chat, chats.session(chat)])
  }
  for (const [to, moved] of homes) agents.rehome([...new Set(moved)], to)
  return rows.map((row) => String(row.id))
}

/** What loading an App starts from: an agent app's name, or an MCP App's call and the entry it was found at. */
export type LaunchSite =
  | { readonly kind: 'agent'; readonly name: string }
  | {
      readonly kind: 'mcp'
      readonly serverId: string
      readonly uri: string
      readonly session: string
      readonly callId: string
      readonly entry?: number
    }

/** Where App `id` is loaded from. */
export function launchSite<RunResult>(db: AppsDb<RunResult>, id: string): LaunchSite {
  const row = rowOf(db, id)
  if (!isMcp(row)) return { kind: 'agent', name: agentAppName(db, id) }
  return {
    kind: 'mcp',
    serverId: row.serverId,
    uri: row.resourceUri,
    session: row.sessionId,
    callId: row.callId,
    ...(row.entryId === null ? {} : { entry: row.entryId }),
  }
}

/** Keeps the entry an MCP App's call was found at, so the next launch reads it there. */
export function keepCallEntry<RunResult>(db: AppsDb<RunResult>, id: string, entry: number): void {
  db.update(appRegistry)
    .set({ entryId: entry })
    .where(and(eq(appRegistry.id, Number(id)), isNull(appRegistry.entryId)))
    .run()
}

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
 * The `mcp_call` with id `callId` in `session` and its committed result: from `at` when it is known, otherwise
 * searched back from the newest entry. `NotFound` when it is not there or has no result yet.
 */
export const findCall = (
  sessions: PiSessions['Service'],
  session: string,
  callId: string,
  at?: number,
): Effect.Effect<AppCall, AppError> =>
  Effect.gen(function* () {
    const found = yield* sessions
      .conversation(session)
      .pipe(Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))))
    if (Option.isNone(found)) return yield* new NotFound({ what: 'conversation' })
    const conversation = found.value
    const entry =
      at ??
      (yield* attempt(async () => {
        let cursor: Parameters<typeof conversation.entries>[2]
        for (let seen = 0; seen < SEARCH;) {
          const page = await conversation.entries({}, 100, cursor, BACKGROUND)
          const made = page.items.find((item) => mcpCallIn(item, callId) !== undefined)
          if (made !== undefined) return made.id
          seen += page.items.length
          if (page.next === undefined) break
          cursor = page.next
        }
        throw new NotFound({ what: 'app call' })
      }))
    const page = yield* attempt(() =>
      conversation.entries(
        { minEntryId: entryId(entry), maxEntryId: entryId(entry + AFTER) },
        AFTER + 1,
        undefined,
        BACKGROUND,
      ),
    )
    const asked = page.items.find((item) => item.id === entry)
    const made = asked === undefined ? undefined : mcpCallIn(asked, callId)
    const result = page.items.map((item) => resultIn(item, callId)).find((each) => each !== undefined)
    if (made === undefined || result === undefined) return yield* new NotFound({ what: 'app call' })
    return { entry, ...made, result: result.details }
  })
