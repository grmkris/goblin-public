import { BREAK, type Migration } from './migration.ts'

/** A Topic's setup as stored before anyone chooses: everything the owner allows (ADR 0040). */
export const EVERYTHING_JSON = '{"mcpServers":"all","skills":"all","apps":"all","subagents":true}'

/** A Persona's setup as stored before anyone chooses: it adds nothing to its Topic's. */
export const NOTHING_JSON = '{"mcpServers":[],"skills":[],"apps":[]}'

/** Topic and Persona setups (ADR 0040, keys from `20261028000000_`). */
export const SETUP_MIGRATIONS: readonly Migration[] = [
  {
    // Every Topic, Personal included, starts with everything, so nothing changes until the owner chooses a list.
    key: '20261028000000_topic_setup',
    tables: ['app_topics'],
    sql: [`ALTER TABLE app_topics ADD COLUMN setup TEXT NOT NULL DEFAULT '${EVERYTHING_JSON}'`].join(BREAK),
  },
  {
    // A Persona's setup is what it adds to its Topic's; every Persona starts adding nothing. A Persona's fork keeps
    // the setup the ask froze, keyed by the fork's chat.
    key: '20261028000100_persona_setup',
    tables: ['app_personas', 'app_persona_revisions', 'app_persona_forks'],
    sql: [
      `ALTER TABLE app_personas ADD COLUMN setup TEXT NOT NULL DEFAULT '${NOTHING_JSON}'`,
      `ALTER TABLE app_persona_revisions ADD COLUMN setup TEXT NOT NULL DEFAULT '${NOTHING_JSON}'`,
      'CREATE TABLE app_persona_forks (chat_id TEXT PRIMARY KEY NOT NULL, persona_id INTEGER NOT NULL, revision INTEGER NOT NULL, setup TEXT NOT NULL, created_at INTEGER NOT NULL)',
    ].join(BREAK),
  },
]
