import type { ToolRegistration } from '@earendil-works/pi-durable'
import {
  type ExclusionTarget,
  type ConversationKind,
  type HelperExclusion,
  type PersonaSetup,
  type SetupItem,
  type TopicSetup,
  hasApp,
  hasLibrary,
  hasServer,
  hasSkill,
  hasTool,
  holds,
  NOTHING,
} from '@goblin/contracts'
import { and, eq, inArray, notInArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import {
  appHelperExclusions,
  appExecutionExclusions,
  appConversations,
  appChannel,
  appMetadata,
  appTelegramChannel,
} from '../storage/schema.ts'
import { appRoutineRuns, appRoutines } from '../storage/routines.ts'
import { appPersonaForks } from '../storage/personas.ts'
import { appTopics } from '../storage/topics.ts'
import { personaSetupOf } from '../personas/registry.ts'
import { topicSetupOf } from '../topics/setup.ts'
import { chatOfSession, chatSession } from '../chats/directory.ts'
import { InvalidInput } from '../http/errors.ts'
import { definitionOf } from '../routines/store.ts'

type Kind = ExclusionTarget['kind']
type Db = DrizzleSqliteDODatabase

/** A conversation's Pi tool filter: the subagent tools removed, or none (`null` clears an inherited one). */
export type PiTools = { readonly remove: readonly ToolRegistration[] } | null

/** One thing switched off in a conversation, as stored: `serverId` empty for subagents, `name` set only for a tool. */
export type Exclusion = { readonly kind: Kind; readonly serverId: string; readonly name: string }

/** What one bound lets a chat use: its Topic's setup, the switches of a chat, a routine's allowed tools. */
type Allow = {
  readonly server: (serverId: string) => boolean
  /** A tool is off when it or its server is. */
  readonly tool: (serverId: string, name: string) => boolean
  /** Whether any skill of the server's library may be used: what reading its listing needs. */
  readonly skills: (serverId: string) => boolean
  /** Whether this one skill may be used, by name and, when known, URI. */
  readonly skill: (serverId: string, name: string, uri?: string) => boolean
  readonly subagents: () => boolean
  readonly app: (name: string) => boolean
}

/** The Topic a chat works in (ADR 0040), and whether its setup holds an item: a refusal says what held it back. */
export type ScopeTopic = { readonly id: number; readonly name: string; readonly holds: (item: SetupItem) => boolean }

/**
 * What a chat's agent may use: its Topic's setup, narrowed by its switches and those of every spawner above a subagent,
 * and by a routine's allowed tools. The one gate every tool and section asks. It only chooses among the owner's grants,
 * which the MCP manager still checks. `editable`: the owner can act on a refusal here (not in a subagent, which follows
 * the chats above it). `topic` is the Topic whose setup bounds it.
 */
export type SetupScope = Allow & { readonly editable: boolean; readonly topic?: ScopeTopic }

/** A conversation the agent does not know may use nothing. */
export const CLOSED: SetupScope = {
  editable: false,
  server: () => false,
  tool: () => false,
  skills: () => false,
  skill: () => false,
  subagents: () => false,
  app: () => false,
}

/** Everything both bounds allow. */
const both = (one: Allow, other: Allow): Allow => ({
  server: (serverId) => one.server(serverId) && other.server(serverId),
  tool: (serverId, name) => one.tool(serverId, name) && other.tool(serverId, name),
  skills: (serverId) => one.skills(serverId) && other.skills(serverId),
  skill: (serverId, name, uri) => one.skill(serverId, name, uri) && other.skill(serverId, name, uri),
  subagents: () => one.subagents() && other.subagents(),
  app: (name) => one.app(name) && other.app(name),
})

/** What a setup lets a chat use: only what it holds. A Persona's setup never holds subagents. */
const setupAllows = (setup: TopicSetup | PersonaSetup): Allow => ({
  server: (serverId) => hasServer(setup, serverId),
  tool: (serverId, name) => hasTool(setup, serverId, name),
  skills: (serverId) => hasLibrary(setup, serverId),
  skill: (serverId, name, uri) => hasSkill(setup, { serverId, name, uri }),
  subagents: () => 'subagents' in setup && setup.subagents,
  app: (name) => hasApp(setup, name),
})

/** The scope of an owner chat of a Topic with nothing else narrowing it: for fixtures and probes. */
export const topicScope = (
  topic: { readonly id: number; readonly name: string; readonly setup: TopicSetup },
  editable = true,
): SetupScope => ({
  ...setupAllows(topic.setup),
  editable,
  topic: { id: topic.id, name: topic.name, holds: (item) => holds(topic.setup, item) },
})

/** Everything either bound allows. */
const either = (one: Allow, other: Allow): Allow => ({
  server: (serverId) => one.server(serverId) || other.server(serverId),
  tool: (serverId, name) => one.tool(serverId, name) || other.tool(serverId, name),
  skills: (serverId) => one.skills(serverId) || other.skills(serverId),
  skill: (serverId, name, uri) => one.skill(serverId, name, uri) || other.skill(serverId, name, uri),
  subagents: () => one.subagents() || other.subagents(),
  app: (name) => one.app(name) || other.app(name),
})

const key = ({ kind, serverId, name }: Exclusion) => `${kind}\n${serverId}\n${name}`

/** The stored row for a target. */
export const exclusionOf = (target: ExclusionTarget): Exclusion => ({
  kind: target.kind,
  serverId: target.kind === 'subagents' ? '' : target.serverId,
  name: target.kind === 'tool' ? target.name : '',
})

/**
 * The scope that switches off everything in `exclusions` (the rows of a conversation and those above it) and the apps
 * in `appsOff`, and nothing else.
 */
export function scopeOf(
  exclusions: readonly Exclusion[],
  editable: boolean,
  appsOff: ReadonlySet<string> = new Set(),
): SetupScope {
  const off = new Set(exclusions.map(key))
  const server = (serverId: string) => !off.has(key({ kind: 'server', serverId, name: '' }))
  return {
    editable,
    server,
    tool: (serverId, name) => server(serverId) && !off.has(key({ kind: 'tool', serverId, name })),
    skills: (serverId) => !off.has(key({ kind: 'skills', serverId, name: '' })),
    skill: (serverId) => !off.has(key({ kind: 'skills', serverId, name: '' })),
    subagents: () => !off.has(key({ kind: 'subagents', serverId: '', name: '' })),
    app: (name) => !appsOff.has(name),
  }
}

// A helper's exclusions (`app_conversation_capabilities`, `app_execution_exclusions`) as functions of the agent's
// database: what its spawner switched off for it (`subagent_config`). A subagent is bounded by every chat above it, read
// live, so it can never do more than the one that started it. Owner chats have no rows: their Topic's setup is what
// they work with (ADR 0040).

/** One conversation in a chain of spawners. */
type Link = {
  readonly session: string
  readonly kind: ConversationKind
  readonly role: string | null
  readonly routineRunId: string | null
  readonly topicId: number
}

/** Called inside a short application transaction, including the first registration of a helper. */
export function writeHelperExclusions(
  db: Db,
  session: string,
  exclusions: readonly HelperExclusion[],
  now: number,
): void {
  db.delete(appHelperExclusions).where(eq(appHelperExclusions.sessionId, session)).run()
  db.delete(appExecutionExclusions).where(eq(appExecutionExclusions.sessionId, session)).run()
  for (const target of exclusions) {
    if (target.kind === 'app') {
      db.insert(appExecutionExclusions)
        .values({ sessionId: session, app: target.app, offAt: now })
        .onConflictDoNothing()
        .run()
    } else {
      db.insert(appHelperExclusions)
        .values({ sessionId: session, ...exclusionOf(target), offAt: now })
        .onConflictDoNothing()
        .run()
    }
  }
}

/** What a helper's spawner switched off for it. */
export const ownExclusions = (db: Db, session: string): readonly Exclusion[] =>
  db
    .select({
      kind: appHelperExclusions.kind,
      serverId: appHelperExclusions.serverId,
      name: appHelperExclusions.name,
    })
    .from(appHelperExclusions)
    .where(eq(appHelperExclusions.sessionId, session))
    .all()

const switchRow = (db: Db, session: string) =>
  db
    .select({
      kind: appConversations.kind,
      role: appConversations.role,
      parent: appConversations.parentSession,
      routineRunId: appConversations.routineRunId,
      topicId: appConversations.topicId,
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
    chain.push({ session: at, kind: row.kind, role: row.role, routineRunId: row.routineRunId, topicId: row.topicId })
    if (row.kind !== 'subagent') return chain
    at = row.parent
  }
  return undefined
}

/**
 * A routine's thread may use only the tools its definition allows, within the scope it would have anyway (its Topic's
 * setup among the rest, ADR 0040); never skills, subagents or app powers.
 */
const routineScope = (db: Db, scope: SetupScope, runId: string): SetupScope => {
  const run = db.select().from(appRoutineRuns).where(eq(appRoutineRuns.id, runId)).get()
  if (run === undefined) return CLOSED
  const definition = definitionOf(run)
  const channel = db.select().from(appTelegramChannel).get() ?? db.select().from(appChannel).get()
  return {
    editable: false,
    ...(scope.topic === undefined ? {} : { topic: scope.topic }),
    server: (id) => scope.server(id) && definition.allowedTools.some((tool) => tool.serverId === id),
    tool: (id, name) =>
      scope.tool(id, name) &&
      (definition.notifyTelegram || channel?.serverId !== id || name !== 'send_message') &&
      definition.allowedTools.some((tool) => tool.serverId === id && tool.name === name),
    skills: () => false,
    skill: () => false,
    subagents: () => false,
    app: () => false,
  }
}

/** A Topic as a scope reads it, live: its name and its setup. A Topic that is not there holds nothing. */
const topicOf = (db: Db, id: number): (ScopeTopic & { readonly setup: TopicSetup }) | undefined => {
  const row = db
    .select({ name: appTopics.name, setup: appTopics.setup })
    .from(appTopics)
    .where(eq(appTopics.id, id))
    .get()
  if (row === undefined) return undefined
  const setup = topicSetupOf(row.setup)
  return { id, name: row.name, setup, holds: (item) => holds(setup, item) }
}

/** The setup a Persona's fork answers with, as the ask froze it; a fork without one adds nothing. */
const forkSetup = (db: Db, chat: string): PersonaSetup | undefined => {
  const row = db
    .select({ setup: appPersonaForks.setup })
    .from(appPersonaForks)
    .where(eq(appPersonaForks.chatId, chat))
    .get()
  return row === undefined ? undefined : personaSetupOf(row.setup)
}

/**
 * What a chat's root works with: its Topic's setup, joined, in a Persona's fork, with the setup the Persona adds
 * (ADR 0040). A Persona never starts subagents and the owner never acts on a refusal there.
 */
const rootBound = (db: Db, root: Link, topic: ScopeTopic & { readonly setup: TopicSetup }) => {
  const added = root.role === 'persona' ? (forkSetup(db, root.session) ?? NOTHING) : undefined
  if (added === undefined) return { allow: setupAllows(topic.setup), topic, persona: false }
  const allow = { ...either(setupAllows(topic.setup), setupAllows(added)), subagents: () => false }
  const holdsEither = (item: SetupItem) => topic.holds(item) || holds(added, item)
  return { allow, topic: { ...topic, holds: holdsEither }, persona: true }
}

/** The apps switched off in any of `sessions` (a helper's exclusions). */
const appsOffIn = (db: Db, sessions: readonly string[]): ReadonlySet<string> =>
  new Set(
    db
      .select({ app: appExecutionExclusions.app })
      .from(appExecutionExclusions)
      .where(inArray(appExecutionExclusions.sessionId, sessions))
      .all()
      .map(({ app }) => app),
  )

/**
 * The scope of a registered chat (ADR 0040): its Topic's setup, read live (joined, in a Persona's fork, with the setup
 * the ask froze), narrowed by its own switches and, for a subagent, those of every spawner above it; a routine's thread
 * is narrowed to its allowed tools as well.
 */
export const chatScope = (db: Db, chat: string): SetupScope => {
  const chain = chainOf(db, chat)
  const start = chain?.[0]
  const root = chain?.at(-1)
  if (chain === undefined || start === undefined || root === undefined) return CLOSED
  const found = topicOf(db, root.topicId)
  if (found === undefined) return CLOSED
  const { allow, topic, persona } = rootBound(db, root, found)
  const editable = start.kind !== 'subagent' && start.routineRunId === null && !persona
  const switches = scopeOf(
    chain.flatMap((link) => ownExclusions(db, link.session)),
    editable,
    appsOffIn(
      db,
      chain.map((link) => link.session),
    ),
  )
  const scope: SetupScope = { ...both(allow, switches), editable, topic }
  return root.routineRunId === null ? scope : routineScope(db, scope, root.routineRunId)
}

/** The scope of the chat a Pi session belongs to; a session no chat owns may use nothing. */
export const sessionScope = (db: Db, session: string): SetupScope => {
  const chat = chatOfSession(db, session)
  return chat === undefined ? CLOSED : chatScope(db, chat)
}

/** App calls follow the same live chain and Topic setup as MCP and skills; routine scopes do not acquire app powers. */
export const appAllowed = (db: Db, session: string, app: string): boolean => sessionScope(db, session).app(app)

/** Pi's tool filter for `chat`: without `subagentTools` when subagents are off where it works, else none. */
export const piToolsFor = (db: Db, subagentTools: readonly ToolRegistration[], chat: string): PiTools =>
  chatScope(db, chat).subagents() ? null : { remove: subagentTools }

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
 * The registered chats whose Pi tool filter follows their scope: all but Persona forks and routine runs, whose filters
 * are set when they are made (a Persona's leaves out the tools it never has). A chat not registered yet (a new agent's
 * main) has nothing to apply.
 */
const filteredChats = (db: Db): readonly string[] =>
  db
    .select({ chat: appConversations.chatId, role: appConversations.role, run: appConversations.routineRunId })
    .from(appConversations)
    .all()
    .filter((row) => row.role !== 'persona' && row.run === null)
    .map((row) => row.chat)

const marked = (db: Db, marker: string): boolean =>
  db.select().from(appMetadata).where(eq(appMetadata.id, marker)).get() !== undefined

/**
 * Applies every filtering conversation's tool filter to Pi again, once per `marker`. Pi keeps a filter as tool
 * names, so one stored before the tools it names changed (`subagent` became the `subagent_*` tools) removes nothing
 * until it is applied again. The marker is written after every conversation is done, so a failure retries them all.
 */
export const retoolOnce = async (retooling: Retooling, marker: string, now: number): Promise<void> => {
  const { db, subagentTools, retool } = retooling
  if (marked(db, marker)) return
  for (const chat of filteredChats(db)) {
    const tools = piToolsFor(db, subagentTools, chat)
    if (tools !== null) await retool(chatSession(db, chat), tools)
  }
  db.insert(appMetadata)
    .values({ id: marker, value: String(now) })
    .onConflictDoNothing()
    .run()
}

/**
 * Applies the Pi filter again to every chat of `topic` whose filter follows its scope, after its setup's subagents
 * changed (ADR 0040). One that fails to apply is left as it was; the next change applies it again.
 */
export const retoolTopic = async (retooling: Retooling, topic: number): Promise<void> => {
  const { db, subagentTools, retool } = retooling
  const inTopic = new Set(
    db
      .select({ chat: appConversations.chatId })
      .from(appConversations)
      .where(eq(appConversations.topicId, topic))
      .all()
      .map(({ chat }) => chat),
  )
  for (const chat of filteredChats(db).filter((each) => inTopic.has(each)))
    await retool(chatSession(db, chat), piToolsFor(db, subagentTools, chat))
}

/** The routines a setup would leave without some of their allowed tools: the ones not done, of `topic`. */
export const routinesOutside = (db: Db, topic: number, setup: TopicSetup) =>
  db
    .select()
    .from(appRoutines)
    .where(
      and(eq(appRoutines.topicId, topic), inArray(appRoutines.state, ['proposed', 'activating', 'active', 'paused'])),
    )
    .all()
    .flatMap((routine) => {
      const definition = definitionOf(routine)
      const outside = definition.allowedTools
        .filter((tool) => !hasTool(setup, tool.serverId, tool.name))
        .map(({ serverId, name }) => ({ serverId, name }))
      return outside.length === 0 ? [] : [{ id: routine.id, title: definition.title, outside }]
    })

/** How many switch rows `dropSwitchesOnce` deleted: servers, tools, libraries and subagents, and apps. */
export type DroppedSwitches = { readonly switches: number; readonly apps: number }

/**
 * Deletes the owner's per-conversation switches once (ADR 0040): every row of a chat that is not a subagent, whose
 * rows are its spawner's exclusions and stay. A chat that had subagents switched off gets its Pi filter applied again
 * after the rows are gone, so it follows its Topic's setup. Answers what was deleted, or nothing when it already ran.
 * A filter that fails to apply is left narrower, never wider; a change of the Topic's subagents applies it again.
 */
export const dropSwitchesOnce = async (
  retooling: Retooling,
  marker: string,
  now: number,
): Promise<DroppedSwitches | undefined> => {
  const { db, subagentTools, retool } = retooling
  if (marked(db, marker)) return undefined
  const helpers = db
    .select({ chat: appConversations.chatId })
    .from(appConversations)
    .where(eq(appConversations.kind, 'subagent'))
  const switches = appHelperExclusions
  const apps = appExecutionExclusions
  const dropped = db.transaction((tx) => {
    const owned = tx.select().from(switches).where(notInArray(switches.sessionId, helpers)).all()
    const ownedApps = tx.select().from(apps).where(notInArray(apps.sessionId, helpers)).all()
    tx.delete(switches).where(notInArray(switches.sessionId, helpers)).run()
    tx.delete(apps).where(notInArray(apps.sessionId, helpers)).run()
    const subagentsOff = owned.filter((row) => row.kind === 'subagents').map((row) => row.sessionId)
    return { counts: { switches: owned.length, apps: ownedApps.length }, subagentsOff }
  })
  const filtered = new Set(filteredChats(db))
  for (const chat of new Set(dropped.subagentsOff))
    if (filtered.has(chat)) await retool(chatSession(db, chat), piToolsFor(db, subagentTools, chat))
  db.insert(appMetadata)
    .values({ id: marker, value: JSON.stringify({ at: now, ...dropped.counts }) })
    .onConflictDoNothing()
    .run()
  return dropped.counts
}

/** The scope and a helper's exclusions as one object over a database, for the probes and test fixtures. Programs use
 * `Setups`. */
export class SetupScopes {
  readonly #retooling: Retooling

  constructor(
    db: Db,
    subagentTools: readonly ToolRegistration[],
    retool: (session: string, tools: PiTools) => Promise<void>,
  ) {
    this.#retooling = { db, subagentTools, retool }
  }

  scope(session: string): SetupScope {
    return sessionScope(this.#retooling.db, session)
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

  piTools(session: string): PiTools {
    return piToolsFor(this.#retooling.db, this.#retooling.subagentTools, session)
  }

  async syncPi(session: string): Promise<void> {
    await syncPi(this.#retooling, session)
  }

  async retoolOnce(marker: string, now: number): Promise<void> {
    await retoolOnce(this.#retooling, marker, now)
  }

  async dropSwitchesOnce(marker: string, now: number): Promise<DroppedSwitches | undefined> {
    return dropSwitchesOnce(this.#retooling, marker, now)
  }
}
