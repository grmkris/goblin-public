import type { Migration } from './migration.ts'

/** First-run Start (ADR 0048): added by its own migration, so dev keeps its data. */
export const ONBOARDING_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261031000200_onboarding',
    tables: ['app_onboarding'],
    sql: "CREATE TABLE app_onboarding (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), status TEXT NOT NULL CHECK (status IN ('open', 'done', 'skipped')), steps TEXT NOT NULL, kickoff_at INTEGER, updated_at INTEGER NOT NULL)",
  },
]
