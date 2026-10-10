import { BREAK, type Migration } from './migration.ts'

/** A Topic's setup as stored before anyone chooses: everything the owner allows (ADR 0040). */
export const EVERYTHING_JSON = '{"mcpServers":"all","skills":"all","apps":"all","subagents":true}'

/** Topic and Persona setups (ADR 0040, keys from `20261028000000_`). */
export const SETUP_MIGRATIONS: readonly Migration[] = [
  {
    // Every Topic, Personal included, starts with everything, so nothing changes until the owner chooses a list.
    key: '20261028000000_topic_setup',
    tables: ['app_topics'],
    sql: [`ALTER TABLE app_topics ADD COLUMN setup TEXT NOT NULL DEFAULT '${EVERYTHING_JSON}'`].join(BREAK),
  },
]
