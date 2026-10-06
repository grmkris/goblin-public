import type { OperatorReadInput, OperatorReads } from '@goblin/contracts/inspect'
import { desc, lt } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { nowMillis } from '../clock.ts'
import { appOperatorReads } from '../storage/schema.ts'

/** How long a read stays on the operator's record. */
export const OPERATOR_READ_RETENTION_MS = 365 * 24 * 60 * 60 * 1000

/**
 * The reads this agent's owner made as an operator (ADR 0024), kept in their own agent: the Worker records each one
 * here before it reads anyone's agent, and refuses the read if the record fails.
 */
export class OperatorReadLog {
  readonly #db: DrizzleSqliteDODatabase
  readonly #clock: () => number

  constructor(db: DrizzleSqliteDODatabase, clock: () => number = nowMillis) {
    this.#db = db
    this.#clock = clock
  }

  record(read: typeof OperatorReadInput.Type): void {
    const at = this.#clock()
    this.#db
      .insert(appOperatorReads)
      .values({
        id: crypto.randomUUID(),
        at,
        userId: read.user,
        clientId: read.clientId,
        clientName: read.clientName ?? null,
        tool: read.tool,
        arguments: read.arguments,
      })
      .run()
    this.#db
      .delete(appOperatorReads)
      .where(lt(appOperatorReads.at, at - OPERATOR_READ_RETENTION_MS))
      .run()
  }

  /** The newest reads first. */
  recent(limit: number): OperatorReads {
    const rows = this.#db.select().from(appOperatorReads).orderBy(desc(appOperatorReads.at)).limit(limit).all()
    return {
      reads: rows.map((row) => ({
        at: row.at,
        user: row.userId,
        clientId: row.clientId,
        ...(row.clientName === null ? {} : { clientName: row.clientName }),
        tool: row.tool,
        arguments: row.arguments,
      })),
    }
  }
}
