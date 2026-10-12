import type { Sql } from './sql.ts'

/** The ledger's tables. Created idempotently when the Durable Object starts. Amounts are integer micro-dollars. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS limits (
    version INTEGER PRIMARY KEY, per_call_micros INTEGER NOT NULL, per_hour_micros INTEGER NOT NULL,
    per_week_micros INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, terms_json TEXT NOT NULL,
    terms_hash TEXT NOT NULL, args_hash TEXT NOT NULL, micros INTEGER NOT NULL, limits_version INTEGER NOT NULL,
    recipient TEXT NOT NULL, client TEXT NOT NULL, payment_json TEXT, delivery_json TEXT, reason TEXT,
    reserved_at_ms INTEGER, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS operations_reserved ON operations (reserved_at_ms)`,
  `CREATE INDEX IF NOT EXISTS operations_created ON operations (created_at_ms)`,
  `CREATE TABLE IF NOT EXISTS approvals (
    operation_id TEXT PRIMARY KEY, reason TEXT NOT NULL, status TEXT NOT NULL, terms_hash TEXT NOT NULL,
    crosses_json TEXT NOT NULL, client TEXT NOT NULL, remember INTEGER NOT NULL DEFAULT 0,
    created_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL, decided_at_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS address_book (
    chain TEXT NOT NULL, address TEXT NOT NULL, label TEXT NOT NULL, added_at_ms INTEGER NOT NULL,
    PRIMARY KEY (chain, address))`,
  `CREATE TABLE IF NOT EXISTS service_overrides (
    id TEXT PRIMARY KEY, allowed INTEGER NOT NULL, rule_json TEXT, updated_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS policy_changes (
    id TEXT PRIMARY KEY, change_text TEXT NOT NULL, reason TEXT NOT NULL, client TEXT NOT NULL,
    status TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY, body_json TEXT NOT NULL, expires_at_ms INTEGER NOT NULL, created_at_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
]

export function migrate(sql: Sql): void {
  for (const statement of SCHEMA) sql.run(statement)
}
