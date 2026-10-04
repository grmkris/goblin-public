import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appClientSessions } from './storage/schema.ts'

/**
 * One Pi conversation per inbound MCP client, so external callers never read or write the owner's main thread. Pi
 * chooses session ids and `create()` is not idempotent, so creation is single-flight per client.
 */
export class ClientSessions {
  readonly #db: DrizzleSqliteDODatabase
  readonly #creating = new Map<string, Promise<string>>()
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  find(clientId: string): string | undefined {
    return this.#db
      .select({ sessionId: appClientSessions.sessionId })
      .from(appClientSessions)
      .where(eq(appClientSessions.clientId, clientId))
      .get()?.sessionId
  }

  /** The client's session, creating it with `create` the first time. */
  ensure(
    clientId: string,
    clientName: string | undefined,
    create: () => Promise<string>,
    now: number,
  ): Promise<string> {
    const existing = this.find(clientId)
    if (existing !== undefined) return Promise.resolve(existing)
    const running = this.#creating.get(clientId)
    if (running !== undefined) return running
    const creation = create()
      .then((sessionId) => {
        this.#db
          .insert(appClientSessions)
          .values({ clientId, sessionId, clientName: clientName ?? null, createdAt: now })
          .onConflictDoNothing()
          .run()
        return this.find(clientId) ?? sessionId
      })
      .finally(() => this.#creating.delete(clientId))
    this.#creating.set(clientId, creation)
    return creation
  }
}
