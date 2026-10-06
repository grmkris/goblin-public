import type { McpServerConfig } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import {
  appConversationCapabilities,
  appMcpCredentials,
  appMcpEndpoints,
  appMcpGrants,
  appMcpOauthPending,
} from '../storage/schema.ts'

type Database = DrizzleSqliteDODatabase

/**
 * Everything stored for a server id: credentials, client registration, pending authorizations, grants, and what
 * conversations switched off on it.
 */
function forget(db: Pick<Database, 'delete'>, serverId: string): void {
  db.delete(appMcpCredentials).where(eq(appMcpCredentials.serverId, serverId)).run()
  db.delete(appMcpOauthPending).where(eq(appMcpOauthPending.serverId, serverId)).run()
  db.delete(appMcpGrants).where(eq(appMcpGrants.serverId, serverId)).run()
  db.delete(appConversationCapabilities).where(eq(appConversationCapabilities.serverId, serverId)).run()
}

/**
 * Credentials and grants belong to the endpoint they were made for. A server id that now points at another endpoint
 * loses everything stored for it, so its tokens never reach the new host and the owner connects (and grants) again.
 * A server seen for the first time is bound to its endpoint. One short transaction; returns the ids that were reset.
 */
export function bindEndpoints(db: Database, servers: readonly McpServerConfig[], now: number): readonly string[] {
  return db.transaction((tx) => {
    const reset: string[] = []
    for (const { serverId, endpoint } of servers) {
      const bound = tx.select().from(appMcpEndpoints).where(eq(appMcpEndpoints.serverId, serverId)).get()
      if (bound?.endpoint === endpoint) continue
      if (bound !== undefined) {
        forget(tx, serverId)
        reset.push(serverId)
      }
      tx.insert(appMcpEndpoints)
        .values({ serverId, endpoint, boundAt: now })
        .onConflictDoUpdate({ target: appMcpEndpoints.serverId, set: { endpoint, boundAt: now } })
        .run()
    }
    return reset
  })
}

/** Forget a server the owner removed: everything stored for it and its endpoint binding, in one transaction. */
export function forgetServer(db: Database, serverId: string, also: (tx: Pick<Database, 'delete'>) => void): void {
  db.transaction((tx) => {
    forget(tx, serverId)
    tx.delete(appMcpEndpoints).where(eq(appMcpEndpoints.serverId, serverId)).run()
    also(tx)
  })
}
