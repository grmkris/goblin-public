/**
 * The ledger's storage seam: a synchronous SQLite. Durable Object storage in production (`fromDurableObjectSql`),
 * Node's `DatabaseSync` in tests (`fromNodeSqlite`). Pattern copied from Sidequest's board store.
 */
export type SqlValue = string | number | null

export interface Sql {
  all<T>(query: string, ...params: SqlValue[]): T[]
  run(query: string, ...params: SqlValue[]): void
  /** Runs `write` as one transaction: all of it lands or none of it. */
  atomic<T>(write: () => T): T
}

/** Cloudflare's `SqlStorage` (`ctx.storage.sql`) with `ctx.storage.transactionSync`. */
export function fromDurableObjectSql(
  sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } },
  atomic: <T>(write: () => T) => T,
): Sql {
  return {
    atomic,
    // SAFETY: the ledger's own SELECTs return the row shapes its callers name.
    all: <T>(query: string, ...params: SqlValue[]) => sql.exec(query, ...params).toArray() as T[],
    run: (query, ...params) => {
      sql.exec(query, ...params).toArray()
    },
  }
}

/** Node's `DatabaseSync` from `node:sqlite`, structurally typed so `src` imports no `node:*`. */
export function fromNodeSqlite(db: {
  prepare(query: string): { all(...params: SqlValue[]): unknown[]; run(...params: SqlValue[]): unknown }
}): Sql {
  return {
    atomic: <T>(write: () => T): T => {
      db.prepare('SAVEPOINT wallet_write').run()
      try {
        const result = write()
        db.prepare('RELEASE wallet_write').run()
        return result
      } catch (error) {
        db.prepare('ROLLBACK TO wallet_write').run()
        db.prepare('RELEASE wallet_write').run()
        throw error
      }
    },
    // SAFETY: the ledger's own SELECTs return the row shapes its callers name.
    all: <T>(query: string, ...params: SqlValue[]) => db.prepare(query).all(...params) as T[],
    run: (query, ...params) => {
      db.prepare(query).run(...params)
    },
  }
}
