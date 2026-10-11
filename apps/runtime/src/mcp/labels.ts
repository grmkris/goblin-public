import { eq, sql } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { Conflict } from '../http/errors.ts'
import { appMcpLabels } from '../storage/schema.ts'
import type { McpServerConfig } from './types.ts'

/** The owner's names for their connections (ADR 0041), unique on the agent whatever their case. */
export interface Labels {
  /** Every connection's label, by connection id. */
  all(): ReadonlyMap<string, string>
  /** The label of `connectionId`, if it has one. */
  of(connectionId: string): string | undefined
  /** A label no connection holds yet: `base`, else `base 2`, `base 3`… */
  free(base: string): string
  /** Names `connectionId` `label`; refuses (409) a label another connection holds. */
  set(connectionId: string, label: string): void
  /** Gives each configured connection a label, its configured one or its id, unless it already has one. */
  ensure(servers: readonly McpServerConfig[]): void
  remove(connectionId: string): void
}

/**
 * How a connection reads in the model's text: the owner's label, with the id the tools take (ADR 0041). The label is the
 * owner's own words, one bounded line; a server's card claims never reach the model (ADR 0006).
 */
export const named = (labels: ReadonlyMap<string, string>, connectionId: string): string => {
  const label = labels.get(connectionId)
  return label === undefined || label === connectionId ? connectionId : `"${label}" (${connectionId})`
}

/** The labels as the owner gives them: one line, no surrounding space. */
export const labelOf = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim().slice(0, 80)

/** `base`, then `base 2`, `base 3`… until `taken` says no. */
export const freeLabel = (base: string, taken: (label: string) => boolean): string => {
  const first = labelOf(base)
  if (!taken(first)) return first
  for (let suffix = 2; ; suffix++) {
    const tail = ` ${String(suffix)}`
    const candidate = `${first.slice(0, 80 - tail.length)}${tail}`
    if (!taken(candidate)) return candidate
  }
}

export class ConnectionLabels implements Labels {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  all(): ReadonlyMap<string, string> {
    return new Map(
      this.#db
        .select()
        .from(appMcpLabels)
        .all()
        .map((row) => [row.connectionId, row.label]),
    )
  }

  of(connectionId: string): string | undefined {
    return this.#db.select().from(appMcpLabels).where(eq(appMcpLabels.connectionId, connectionId)).get()?.label
  }

  #holder(label: string): string | undefined {
    return this.#db
      .select()
      .from(appMcpLabels)
      .where(sql`${appMcpLabels.label} = ${label} COLLATE NOCASE`)
      .get()?.connectionId
  }

  free(base: string): string {
    return freeLabel(base, (label) => this.#holder(label) !== undefined)
  }

  set(connectionId: string, label: string): void {
    const holder = this.#holder(label)
    if (holder !== undefined && holder !== connectionId) throw new Conflict({ reason: 'label_taken' })
    this.#db
      .insert(appMcpLabels)
      .values({ connectionId, label })
      .onConflictDoUpdate({ target: appMcpLabels.connectionId, set: { label } })
      .run()
  }

  ensure(servers: readonly McpServerConfig[]): void {
    for (const server of servers)
      if (this.of(server.connectionId) === undefined)
        this.set(server.connectionId, this.free(server.label ?? server.connectionId))
  }

  remove(connectionId: string): void {
    this.#db.delete(appMcpLabels).where(eq(appMcpLabels.connectionId, connectionId)).run()
  }
}
