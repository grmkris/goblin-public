import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpServers } from '../storage/schema.ts'
import type { ServerClaims } from './endpoint.ts'
import { bindEndpoints, forgetServer } from './endpoints.ts'
import type { McpServerConfig } from './types.ts'

/** Where an added server was found: a registry entry (name and version), or nothing for a pasted URL. */
export type ServerSource = {
  readonly registry: string
  readonly name: string
  readonly version?: string | undefined
}

export type AddedServer = McpServerConfig & ServerClaims & { readonly source?: ServerSource }

/** At most this many added servers per agent. */
export const MAX_ADDED_SERVERS = 16

/** The owner's added servers (the host depends on this, not on SQLite). */
export interface AddedServers {
  list(): readonly AddedServer[]
  add(server: AddedServer, now: number): void
  /** Forget the server and everything stored for it: credentials, grants, pending sign-ins. */
  remove(serverId: string): void
}

const sourceOf = (json: string | null): ServerSource | undefined => {
  if (json === null) return undefined
  // SAFETY: written by `add` as JSON.stringify of a ServerSource; nothing else writes this column.
  return JSON.parse(json) as ServerSource
}

export class AddedServerStore implements AddedServers {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  list(): readonly AddedServer[] {
    return this.#db
      .select()
      .from(appMcpServers)
      .all()
      .map((row) => {
        const source = sourceOf(row.source)
        return {
          serverId: row.serverId,
          endpoint: row.endpoint,
          ...(row.title === null ? {} : { title: row.title }),
          ...(row.description === null ? {} : { description: row.description }),
          ...(row.icon === null ? {} : { icon: row.icon }),
          ...(source === undefined ? {} : { source }),
        }
      })
  }

  add(server: AddedServer, now: number): void {
    this.#db
      .insert(appMcpServers)
      .values({
        serverId: server.serverId,
        endpoint: server.endpoint,
        title: server.title ?? null,
        description: server.description ?? null,
        icon: server.icon ?? null,
        source: server.source === undefined ? null : JSON.stringify(server.source),
        createdAt: now,
      })
      .run()
    bindEndpoints(this.#db, [server], now)
  }

  remove(serverId: string): void {
    forgetServer(this.#db, serverId, (tx) => tx.delete(appMcpServers).where(eq(appMcpServers.serverId, serverId)).run())
  }
}
