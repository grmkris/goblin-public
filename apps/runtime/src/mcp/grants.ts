import type { Grant } from '@goblin/contracts'
import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpGrants } from '../storage/schema.ts'
import { GrantDenied } from '../http/errors.ts'

/** The owner's grants are the contract's (`@goblin/contracts`), which the web reads too. */
export type { Grant, GrantCapability } from '@goblin/contracts'

export interface Grants {
  allows(grant: Grant): boolean
  list(connectionId?: string): readonly Grant[]
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
            eq(appMcpGrants.connectionId, grant.connectionId),
            eq(appMcpGrants.capability, grant.capability),
            eq(appMcpGrants.name, grant.name),
          ),
        )
        .get() !== undefined
    )
  }

  list(connectionId?: string): readonly Grant[] {
    const query = this.#db
      .select({
        connectionId: appMcpGrants.connectionId,
        capability: appMcpGrants.capability,
        name: appMcpGrants.name,
        askFirst: appMcpGrants.askFirst,
      })
      .from(appMcpGrants)
    return (connectionId === undefined ? query : query.where(eq(appMcpGrants.connectionId, connectionId))).all()
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
          eq(appMcpGrants.connectionId, grant.connectionId),
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
          eq(appMcpGrants.connectionId, grant.connectionId),
          eq(appMcpGrants.capability, grant.capability),
          eq(appMcpGrants.name, grant.name),
        ),
      )
      .get()
  }

  setAskFirst(grant: Grant, enabled: boolean): void {
    if (!this.allows(grant)) throw new GrantDenied({ connectionId: grant.connectionId, name: grant.name })
    this.#db
      .update(appMcpGrants)
      .set({ askFirst: enabled, version: crypto.randomUUID() })
      .where(
        and(
          eq(appMcpGrants.connectionId, grant.connectionId),
          eq(appMcpGrants.capability, grant.capability),
          eq(appMcpGrants.name, grant.name),
        ),
      )
      .run()
  }
}
