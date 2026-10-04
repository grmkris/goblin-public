import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpRegistries } from '../storage/schema.ts'
import type { Registry } from './registry.ts'

/** At most this many registries an owner may add. */
export const MAX_ADDED_REGISTRIES = 8

/** The registries the owner added (the host depends on this, not on SQLite). */
export interface AddedRegistries {
  list(): readonly Registry[]
  add(registry: Registry, now: number): void
  remove(url: string): void
}

export class RegistryStore implements AddedRegistries {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  list(): readonly Registry[] {
    return this.#db
      .select({ url: appMcpRegistries.url, title: appMcpRegistries.title })
      .from(appMcpRegistries)
      .orderBy(appMcpRegistries.addedAt)
      .all()
  }

  add(registry: Registry, now: number): void {
    this.#db.insert(appMcpRegistries).values({ url: registry.url, title: registry.title, addedAt: now }).run()
  }

  remove(url: string): void {
    this.#db.delete(appMcpRegistries).where(eq(appMcpRegistries.url, url)).run()
  }
}
