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
import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import { chatOfSession, chatSession, primaryChat } from '../chats/directory.ts'
import { InvalidInput } from '../http/errors.ts'

type Kind = CapabilityTarget['kind']
type Db = DrizzleSqliteDODatabase

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

/** A conversation the agent does not know may use nothing. */
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

// Each conversation's switches (`app_conversation_capabilities`) as functions of the agent's database: only what is off
// is stored, so a tool granted later is on everywhere until switched off. A thread copies the switches of the
// conversation it came from when it is created. A subagent may store its parent's exclusions too: it is bounded by
// every conversation above it, read live, so it can never do more than the one that started it.

/** One conversation in a chain of spawners. */
type Link = { readonly session: string; readonly kind: ConversationKind; readonly routineRunId: string | null }

/** Rows per insert: five bound values each, under SQLite's limit of 100 per statement on Cloudflare. */
const INSERT_ROWS = 20

/** Called inside a short application transaction, including the first registration of a helper. */
export function writeHelperExclusions(
  db: Db,
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

/** What `session` switched off itself. */
export const ownExclusions = (db: Db, session: string): readonly Exclusion[] =>
  db
    .select({
      kind: appConversationCapabilities.kind,
      serverId: appConversationCapabilities.serverId,
      name: appConversationCapabilities.name,
    })
    .from(appConversationCapabilities)
    .where(eq(appConversationCapabilities.sessionId, session))
    .all()

const switchRow = (db: Db, session: string) =>
  db
    .select({
      kind: appConversations.kind,
      parent: appConversations.parentSession,
      routineRunId: appConversations.routineRunId,
    })
    .from(appConversations)
    .where(eq(appConversations.chatId, session))
    .get()

/**
 * The conversations whose switches bound `session`: it, then each spawner while that is a subagent, up to the first
 * conversation that is not (whose own switches are whole). Subagents nest without a depth limit; a conversation seen
 * twice or a subagent without a spawner breaks the chain (`undefined`), and a broken chain may use nothing.
 */
const chainOf = (db: Db, session: string): readonly Link[] | undefined => {
  const chain: Link[] = []
  const seen = new Set<string>()
  for (let at: string | null = session; at !== null && !seen.has(at);) {
    const row = switchRow(db, at)
    if (row === undefined) return undefined
    seen.add(at)
    chain.push({ session: at, kind: row.kind, routineRunId: row.routineRunId })
    if (row.kind !== 'subagent') return chain
    at = row.parent
  }
  return undefined
}

/** What `session` works without: its own switches and, for a subagent, those of every spawner above it. */
const effectiveExclusions = (db: Db, session: string): readonly Exclusion[] | undefined =>
  chainOf(db, session)?.flatMap((link) => ownExclusions(db, link.session))

/** A routine's thread may use only the tools its definition allows, within the scope it would have anyway. */
const routineScope = (db: Db, scope: CapabilityScope, runId: string): CapabilityScope => {
  const run = db.select().from(appRoutineRuns).where(eq(appRoutineRuns.id, runId)).get()
  if (run === undefined) return CLOSED
  const definition = Schema.decodeUnknownSync(RoutineDefinition)(JSON.parse(run.definitionJson))
  const channel = db.select().from(appTelegramChannel).get() ?? db.select().from(appChannel).get()
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

/** The scope of a registered conversation: its own switches, and for a subagent those of every spawner above it. */
export const capabilityScope = (db: Db, session: string): CapabilityScope => {
  const chat = chatOfSession(db, session)
  const chain = chat === undefined ? undefined : chainOf(db, chat)
  const start = chain?.[0]
  const root = chain?.at(-1)
  if (chain === undefined || start === undefined || root === undefined) return CLOSED
  const scope = scopeOf(
    chain.flatMap((link) => ownExclusions(db, link.session)),
    start.kind !== 'subagent' && start.routineRunId === null,
  )
  return root.routineRunId === null ? scope : routineScope(db, scope, root.routineRunId)
}

/** App calls follow the same live chain as MCP and skills; routine scopes do not acquire app powers. */
export const appAllowed = (db: Db, session: string, app: string): boolean => {
  const chat = chatOfSession(db, session)
  const chain = chat === undefined ? undefined : chainOf(db, chat)
  if (chain === undefined || chain.some((link) => link.routineRunId !== null)) return false
  const sessions = chain.map((link) => link.session)
  return !db
    .select()
    .from(appExecutionExclusions)
    .where(and(inArray(appExecutionExclusions.sessionId, sessions), eq(appExecutionExclusions.app, app)))
    .get()
}

/** Switch one thing on or off in `session`. A server switched back on keeps the tools switched off under it. */
export const setExclusion = (db: Db, session: string, target: CapabilityTarget, on: boolean, now: number): void => {
  const { kind, serverId, name } = exclusionOf(target)
  const table = appConversationCapabilities
  if (on)
    db.delete(table)
      .where(
        and(eq(table.sessionId, session), eq(table.kind, kind), eq(table.serverId, serverId), eq(table.name, name)),
      )
      .run()
  else db.insert(table).values({ sessionId: session, kind, serverId, name, offAt: now }).onConflictDoNothing().run()
}

/**
 * Switches more things off in `session`, never anything on: a Persona's fork starts with its parent's switches, then
 * gains its own exclusions and no subagents. Pi's tool filter for the fork was set when it was forked.
 */
export const narrowExclusions = (
  db: Db,
  session: string,
  exclusions: readonly HelperExclusion[],
  now: number,
): void => {
  db.transaction(() => {
    for (const target of exclusions) {
      if (target.kind === 'app')
        db.insert(appExecutionExclusions)
          .values({ sessionId: session, app: target.app, offAt: now })
          .onConflictDoNothing()
          .run()
      else setExclusion(db, session, target, false, now)
    }
  })
}

/**
 * Give `to` exactly the switches `from` works under (a new thread copies its parent's; Reset copies them again). From
 * a subagent that is its spawners' switches, since it stores none of its own.
 */
export const copyExclusions = (db: Db, from: string, to: string, now: number): void => {
  const rows = (effectiveExclusions(db, from) ?? ownExclusions(db, from)).map((exclusion) => ({
    ...exclusion,
    sessionId: to,
    offAt: now,
  }))
  db.transaction((tx) => {
    tx.delete(appConversationCapabilities).where(eq(appConversationCapabilities.sessionId, to)).run()
    const chain = chainOf(db, from)
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
      tx.insert(appExecutionExclusions).values({ sessionId: to, app: row.app, offAt: now }).onConflictDoNothing().run()
    for (let start = 0; start < rows.length; start += INSERT_ROWS)
      tx.insert(appConversationCapabilities)
        .values(rows.slice(start, start + INSERT_ROWS))
        .onConflictDoNothing()
        .run()
  })
}

/** The conversation a thread's switches come back from on Reset: the one it came from (main for one started empty). */
const resetSource = (db: Db, thread: string): string => switchRow(db, thread)?.parent ?? primaryChat

/** What Reset gives `thread`: the switches of the conversation it came from. */
export const inheritedExclusions = (db: Db, thread: string): readonly Exclusion[] =>
  effectiveExclusions(db, resetSource(db, thread)) ?? []

/** Pi's tool filter for `session`: without `subagentTools` when subagents are off where it works, else none. */
export const piToolsFor = (db: Db, subagentTools: readonly ToolRegistration[], session: string): PiTools => {
  const effective = effectiveExclusions(db, session)
  return effective !== undefined && scopeOf(effective, true).subagents() ? null : { remove: subagentTools }
}

/**
 * What applying the switches to Pi takes: the database, the subagent tools Pi's tool filter removes where subagents
 * are off, and `retool`, which sets a Pi conversation's filter (outside any SQLite transaction).
 */
export type Retooling = {
  readonly db: Db
  readonly subagentTools: readonly ToolRegistration[]
  readonly retool: (session: string, tools: PiTools) => Promise<void>
}

/** Applies `session`'s tool filter to its Pi conversation, after the switches are stored. */
export const syncPi = async ({ db, subagentTools, retool }: Retooling, session: string): Promise<void> => {
  await retool(chatSession(db, session), piToolsFor(db, subagentTools, session))
}

/** A thread's switches back to those of the conversation it came from, applied to Pi too. */
export const resetSwitches = async (retooling: Retooling, thread: string, now: number): Promise<void> => {
  copyExclusions(retooling.db, resetSource(retooling.db, thread), thread, now)
  await syncPi(retooling, thread)
}

/** Only the direct parent can configure a registered helper. Exclusions cannot widen any ancestor's ceiling. */
export const configureHelper = async (
  retooling: Retooling,
  helper: { readonly parent: string; readonly session: string; readonly exclusions: readonly HelperExclusion[] },
  now: number,
): Promise<void> => {
  const { db } = retooling
  const chat = chatOfSession(db, helper.session)
  const parentChat = chatOfSession(db, helper.parent)
  const row = chat === undefined ? undefined : switchRow(db, chat)
  if (chat === undefined || parentChat === undefined || row?.kind !== 'subagent' || row.parent !== parentChat)
    throw new InvalidInput({ reason: 'helper_parent' })
  db.transaction(() => writeHelperExclusions(db, chat, helper.exclusions, now))
  await syncPi(retooling, chat)
}

/**
 * Applies every filtering conversation's tool filter to Pi again, once per `marker`. Pi keeps a filter as tool
 * names, so one stored before the tools it names changed (`subagent` became the `subagent_*` tools) removes nothing
 * until it is applied again. The marker is written after every conversation is done, so a failure retries them all.
 */
export const retoolOnce = async (retooling: Retooling, marker: string, now: number): Promise<void> => {
  const { db, subagentTools, retool } = retooling
  if (db.select().from(appMetadata).where(eq(appMetadata.id, marker)).get() !== undefined) return
  // Registered conversations only: one not registered yet (a new agent's main) has no switches to apply.
  for (const { session } of db.select({ session: appConversations.chatId }).from(appConversations).all()) {
    const tools = piToolsFor(db, subagentTools, session)
    if (tools !== null) await retool(chatSession(db, session), tools)
  }
  db.insert(appMetadata)
    .values({ id: marker, value: String(now) })
    .onConflictDoNothing()
    .run()
}

/**
 * The switches as one object over a database, for code outside the services that takes one (a Topic's ports, the
 * probes). Programs use the `Capabilities` service.
 */
export class CapabilityProfiles {
  readonly #retooling: Retooling

  constructor(
    db: Db,
    subagentTools: readonly ToolRegistration[],
    retool: (session: string, tools: PiTools) => Promise<void>,
  ) {
    this.#retooling = { db, subagentTools, retool }
  }

  own(session: string): readonly Exclusion[] {
    return ownExclusions(this.#retooling.db, session)
  }

  scope(session: string): CapabilityScope {
    return capabilityScope(this.#retooling.db, session)
  }

  app(session: string, app: string): boolean {
    return appAllowed(this.#retooling.db, session, app)
  }

  async configureHelper(
    parent: string,
    session: string,
    exclusions: readonly HelperExclusion[],
    now: number,
  ): Promise<void> {
    await configureHelper(this.#retooling, { parent, session, exclusions }, now)
  }

  narrow(session: string, exclusions: readonly HelperExclusion[], now: number): void {
    narrowExclusions(this.#retooling.db, session, exclusions, now)
  }

  set(session: string, target: CapabilityTarget, on: boolean, now: number): void {
    setExclusion(this.#retooling.db, session, target, on, now)
  }

  copy(from: string, to: string, now: number): void {
    copyExclusions(this.#retooling.db, from, to, now)
  }

  inherited(thread: string): readonly Exclusion[] {
    return inheritedExclusions(this.#retooling.db, thread)
  }

  async reset(thread: string, now: number): Promise<void> {
    await resetSwitches(this.#retooling, thread, now)
  }

  piTools(session: string): PiTools {
    return piToolsFor(this.#retooling.db, this.#retooling.subagentTools, session)
  }

  async syncPi(session: string): Promise<void> {
    await syncPi(this.#retooling, session)
  }

  async retoolOnce(marker: string, now: number): Promise<void> {
    await retoolOnce(this.#retooling, marker, now)
  }
}

/**
 * The agent's switches object, made at the start (`layers/capabilities.ts`) for a Topic's ports, which change switches
 * inside their own synchronous writes. Programs use the `Capabilities` service.
 */
export class ProfilesInstance extends Context.Service<ProfilesInstance, CapabilityProfiles>()(
  'goblin/capabilities/ProfilesInstance',
) {}
