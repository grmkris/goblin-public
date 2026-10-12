import type { Migration } from './migration.ts'

/** The owner's sidebar pins (ADR 0053, keys from `20261031005300_`): added by its own migration, so dev keeps its data. */
export const SIDEBAR_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261031005300_sidebar',
    tables: ['app_sidebar'],
    sql: 'CREATE TABLE app_sidebar (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), revision INTEGER NOT NULL, pins TEXT NOT NULL)',
  },
]
