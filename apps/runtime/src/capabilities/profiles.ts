import type { ToolRegistration } from '@earendil-works/pi-durable'
import { type CapabilityTarget, MAIN_THREAD } from '@purrable/contracts'
import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appConversationCapabilities, appConversations } from '../storage/schema.ts'

type Kind = CapabilityTarget['kind']

/** A conversation's Pi tool filter: the `subagent` tool removed, or none (`null` clears an inherited one). */
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

/** How far up a subagent's spawners the scope is read; deeper than this is refused rather than followed. */
const MAX_DEPTH = 8

/**
 * Each conversation's switches (`app_conversation_capabilities`): only what is off is stored, so a tool granted later is
 * on everywhere until switched off. A thread copies main's switches when it is created. A subagent stores none: it is
 * bounded by every conversation above it, read live, so it can never do more than the one that started it.
 * `subagentTool` is what Pi's per-conversation tool filter removes when subagents are off; `retool` applies that
 * filter to a conversation in Pi (outside any SQLite transaction).
 */
export class CapabilityProfiles {
  readonly #db: DrizzleSqliteDODatabase
  readonly #subagentTool: ToolRegistration
  readonly #retool: (session: string, tools: PiTools) => Promise<void>

  constructor(
    db: DrizzleSqliteDODatabase,
    subagentTool: ToolRegistration,
    retool: (session: string, tools: PiTools) => Promise<void>,
  ) {
    this.#db = db
    this.#subagentTool = subagentTool
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
      .select({ kind: appConversations.kind, parent: appConversations.parentSession })
      .from(appConversations)
      .where(eq(appConversations.sessionId, session))
      .get()
  }

  /** The scope of a registered conversation: its own switches, and for a subagent those of every spawner above it. */
  scope(session: string): CapabilityScope {
    const start = this.#conversation(session)
    if (start === undefined) return CLOSED
    const exclusions = [...this.own(session)]
    let current = start
    for (let depth = 0; current.kind === 'subagent'; depth += 1) {
      const above = current.parent === null ? undefined : this.#conversation(current.parent)
      if (above === undefined || current.parent === null || depth >= MAX_DEPTH) return CLOSED
      exclusions.push(...this.own(current.parent))
      current = above
    }
    return scopeOf(exclusions, start.kind !== 'subagent')
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

  /** Give `to` exactly the switches of `from` (a new thread copies main's; Reset copies them again). */
  copy(from: string, to: string, now: number): void {
    const rows = this.own(from).map((exclusion) => ({ ...exclusion, sessionId: to, offAt: now }))
    this.#db.transaction((tx) => {
      tx.delete(appConversationCapabilities).where(eq(appConversationCapabilities.sessionId, to)).run()
      if (rows.length > 0) tx.insert(appConversationCapabilities).values(rows).run()
    })
  }

  /** A thread's switches back to main's, applied to Pi too. */
  async reset(thread: string, now: number): Promise<void> {
    this.copy(MAIN_THREAD, thread, now)
    await this.syncPi(thread)
  }

  /** Pi's tool filter for `session`: without `subagent` when subagents are off there, else none. */
  piTools(session: string): PiTools {
    return scopeOf(this.own(session), true).subagents() ? null : { remove: [this.#subagentTool] }
  }

  /** Applies `session`'s tool filter to its Pi conversation, after the switches are stored. */
  async syncPi(session: string): Promise<void> {
    await this.#retool(session, this.piTools(session))
  }
}
