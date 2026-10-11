import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { appMcpEventOffers } from '../../storage/schema.ts'

/** What the owner did with a connection's offer of events (ADR 0041): dismissed it, or set up a routine on it. */
export type SettledOffer = 'dismissed' | 'done'

/** The owner's answers to their connections' offers of events, by connection. */
export interface EventOffers {
  /** What the owner did with `connectionId`'s offer; none while it is open. */
  settled(connectionId: string): SettledOffer | undefined
  /** Records `state` for `connectionId`; a dismissal never undoes a routine set up on it. */
  settle(connectionId: string, state: SettledOffer, at: number): void
  remove(connectionId: string): void
}

/** The offers' answers in the agent's SQLite (`app_mcp_event_offers`). */
export class ConnectionEventOffers implements EventOffers {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }
  settled(connectionId: string): SettledOffer | undefined {
    return this.#db
      .select({ state: appMcpEventOffers.state })
      .from(appMcpEventOffers)
      .where(eq(appMcpEventOffers.connectionId, connectionId))
      .get()?.state
  }
  settle(connectionId: string, state: SettledOffer, at: number): void {
    if (state === 'dismissed' && this.settled(connectionId) === 'done') return
    this.#db
      .insert(appMcpEventOffers)
      .values({ connectionId, state, at })
      .onConflictDoUpdate({ target: appMcpEventOffers.connectionId, set: { state, at } })
      .run()
  }
  remove(connectionId: string): void {
    this.#db.delete(appMcpEventOffers).where(eq(appMcpEventOffers.connectionId, connectionId)).run()
  }
}
