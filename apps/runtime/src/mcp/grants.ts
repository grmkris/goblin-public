import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpGrants } from '../storage/schema.ts'

export type GrantCapability = 'tool' | 'resource' | 'prompt'
export type Grant = { readonly serverId: string; readonly capability: GrantCapability; readonly name: string }

export interface Grants {
  allows(grant: Grant): boolean
  list(serverId?: string): readonly Grant[]
  set(grant: Grant, allowed: boolean, now: number): void
}

/** The owner's exact allow-list. Absence is denial; there are no wildcards. */
export class GrantStore implements Grants {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  allows(grant: Grant): boolean {
    return (
      this.#db
        .select({ name: appMcpGrants.name })
        .from(appMcpGrants)
        .where(
          and(
            eq(appMcpGrants.serverId, grant.serverId),
            eq(appMcpGrants.capability, grant.capability),
            eq(appMcpGrants.name, grant.name),
          ),
        )
        .get() !== undefined
    )
  }

  list(serverId?: string): readonly Grant[] {
    const query = this.#db
      .select({ serverId: appMcpGrants.serverId, capability: appMcpGrants.capability, name: appMcpGrants.name })
      .from(appMcpGrants)
    return (serverId === undefined ? query : query.where(eq(appMcpGrants.serverId, serverId))).all()
  }

  set(grant: Grant, allowed: boolean, now: number): void {
    if (allowed) {
      this.#db
        .insert(appMcpGrants)
        .values({ ...grant, createdAt: now })
        .onConflictDoNothing()
        .run()
      return
    }
    this.#db
      .delete(appMcpGrants)
      .where(
        and(
          eq(appMcpGrants.serverId, grant.serverId),
          eq(appMcpGrants.capability, grant.capability),
          eq(appMcpGrants.name, grant.name),
        ),
      )
      .run()
  }
}
