import { BREAK, type Migration } from './migration.ts'

/**
 * How goblin pays for its model calls (ADR 0047, keys from `20261031000300_`): added by its own migration, so dev and
 * prod keep their data. A model pick of a paid route (`paid:goblin`, `paid:tempo`), which this replaces, becomes the
 * pay mode `wallet` on that route, and the pick goes back to the stage's default model.
 */
export const PAY_MIGRATIONS: readonly Migration[] = [
  {
    key: '20261031000300_pay_mode',
    tables: ['app_pay_mode', 'app_model_choice'],
    sql: [
      `CREATE TABLE app_pay_mode (id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1), mode TEXT NOT NULL CHECK (mode IN ('credits-then-wallet', 'credits', 'wallet')), route TEXT NOT NULL CHECK (route IN ('goblin', 'tempo')), updated_at INTEGER NOT NULL)`,
      `INSERT INTO app_pay_mode (id, mode, route, updated_at) SELECT 1, 'wallet', substr(model_id, 6), updated_at FROM app_model_choice WHERE id = 1 AND model_id IN ('paid:goblin', 'paid:tempo')`,
      `DELETE FROM app_model_choice WHERE model_id LIKE 'paid:%'`,
    ].join(BREAK),
  },
]
