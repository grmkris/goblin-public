import type { SubmissionRecord } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { NotFound } from '../src/http/errors.ts'
import { Inspection, type InspectionSources, makeInspection } from '../src/inspect/service.ts'
import { RunLedger } from '../src/telemetry/ledger.ts'
import { chatDatabase } from './chats-sqlite.ts'

/** The registered chats the fixture knows: main (`1`, Pi session `1`) and a thread (`12`, Pi session `40`). */
const SESSIONS: Readonly<Record<string, string>> = { '1': '1', '12': '40' }

/**
 * `Inspection` as the agent builds it, over a real run ledger on SQLite. The chats are the two above with empty
 * histories, and Pi settles whatever `settled` names (nothing by default). Close it after the test.
 */
export function inspectionFixture(settled: Readonly<Record<string, SubmissionRecord>> = {}) {
  const { db, close } = chatDatabase()
  const ledger = new RunLedger(db)
  const chats: InspectionSources['chats'] = {
    list: Effect.succeed([]),
    require: (chat) => {
      const session = SESSIONS[chat]
      return session === undefined ? Effect.fail(new NotFound({ what: 'conversation' })) : Effect.succeed(session)
    },
    history: () => Effect.succeed({ entries: [], more: false }),
  }
  const inspection = makeInspection({
    ledger,
    chats,
    settlement: (session, operationId) => Effect.succeed(settled[`${session}/${operationId}`]),
  })
  return { ledger, inspection, layer: Layer.succeed(Inspection, inspection), close }
}
