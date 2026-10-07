import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpGrants } from '../storage/schema.ts'
import { GrantDenied } from '../http/errors.ts'

export type GrantCapability = 'tool' | 'resource' | 'prompt'
export type Grant = {
  readonly serverId: string
  readonly capability: GrantCapability
  readonly name: string
  readonly askFirst?: boolean
}

export interface Grants {
  allows(grant: Grant): boolean
  list(serverId?: string): readonly Grant[]
  set(grant: Grant, allowed: boolean, now: number): void
  policy(grant: Grant): { readonly askFirst: boolean; readonly version: string } | undefined
  setAskFirst(grant: Grant, enabled: boolean): void
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
      .select({
        serverId: appMcpGrants.serverId,
        capability: appMcpGrants.capability,
        name: appMcpGrants.name,
        askFirst: appMcpGrants.askFirst,
      })
      .from(appMcpGrants)
    return (serverId === undefined ? query : query.where(eq(appMcpGrants.serverId, serverId))).all()
  }

  set(grant: Grant, allowed: boolean, now: number): void {
    if (allowed) {
      this.#db
        .insert(appMcpGrants)
        .values({ ...grant, askFirst: grant.askFirst ?? false, version: crypto.randomUUID(), createdAt: now })
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

  policy(grant: Grant): { readonly askFirst: boolean; readonly version: string } | undefined {
    return this.#db
      .select({ askFirst: appMcpGrants.askFirst, version: appMcpGrants.version })
      .from(appMcpGrants)
      .where(
        and(
          eq(appMcpGrants.serverId, grant.serverId),
          eq(appMcpGrants.capability, grant.capability),
          eq(appMcpGrants.name, grant.name),
        ),
      )
      .get()
  }

  setAskFirst(grant: Grant, enabled: boolean): void {
    if (!this.allows(grant)) throw new GrantDenied({ serverId: grant.serverId, name: grant.name })
    this.#db
      .update(appMcpGrants)
      .set({ askFirst: enabled, version: crypto.randomUUID() })
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
