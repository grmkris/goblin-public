import { BREAK, type Migration } from './migration.ts'

/** The typed decisions' migration (ADR 0031): its key and statements are the ones dev applied, so dev skips it. */
export const DECISION_MIGRATIONS: readonly Migration[] = [
  {
    // Typed decisions (ADR 0031): owner-confirmed proposals and the first owner label of each.
    key: '20261026000600_decisions',
    tables: ['app_decision_proposals', 'app_decision_labels'],
    sql: [
      "CREATE TABLE app_decision_proposals (id TEXT PRIMARY KEY NOT NULL, chat_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('open','confirmed','dismissed','stale')), probability REAL NOT NULL CHECK (probability BETWEEN 0 AND 1), provider TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER)",
      'CREATE INDEX app_decisions_chat_state ON app_decision_proposals (chat_id, state)',
      "CREATE TABLE app_decision_labels (proposal_id TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL CHECK (label IN ('confirm','dismiss')), judged_at INTEGER NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, probability REAL NOT NULL CHECK (probability BETWEEN 0 AND 1))",
    ].join(BREAK),
  },
]
