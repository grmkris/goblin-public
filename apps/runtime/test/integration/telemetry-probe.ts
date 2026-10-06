import { MAIN_THREAD } from '@goblin/contracts'
import type { InspectQuery } from '@goblin/contracts/inspect'
import { runTelemetry } from '../../src/telemetry/run.ts'

type Row = { kind: string; status: string; operation_id: string | null; attributes: string }
const json = (text: string): unknown => JSON.parse(text)

/** The agent's own `/inspect` route: a query in, its encoded result out. */
type Inspect = (query: InspectQuery | { readonly kind: string }) => Promise<unknown>

/**
 * The run ledger on the agent's real SQLite (ADR 0024): one owner turn with a tool call, the rows it left for that
 * operation, the inspection route reading that turn back, then the restart sweep interrupting a row left started and
 * `problems` reporting it. As JSON text.
 */
export async function telemetryProbe(
  storage: DurableObjectStorage,
  owner: string,
  turn: (text: string, operationId: string) => Promise<unknown>,
  inspect: Inspect,
): Promise<string> {
  await turn('call subagent {"action":"status"}', 'telemetry-turn')
  const rows = storage.sql
    .exec<Row>(
      'SELECT kind, status, operation_id, attributes FROM app_run_events WHERE operation_id = ? ORDER BY started_at, id',
      'telemetry-turn',
    )
    .toArray()
    .map((row) => ({ kind: row.kind, status: row.status, attributes: json(row.attributes) }))
  const inspected = {
    turn: await inspect({ kind: 'turn', operationId: 'telemetry-turn' }),
    turns: await inspect({ kind: 'turns', conversation: MAIN_THREAD }),
    conversation: await inspect({ kind: 'conversation', conversation: MAIN_THREAD }),
    missing: await inspect({ kind: 'turn', operationId: 'no-such-turn' }),
    invalid: await inspect({ kind: 'everything' }),
  }
  // The agent's own diagnose tool reads the same turn back from the ledger.
  const diagnosed = JSON.stringify(await turn('call diagnose {"operationId":"telemetry-turn"}', 'diagnose-turn'))
  storage.sql.exec(
    `INSERT INTO app_run_events (id, kind, status, started_at, attributes) VALUES ('probe:left', 'tool.call', 'started', ?, '{}')`,
    Date.now(),
  )
  runTelemetry(storage, () => owner).restarted(Date.now())
  const left = storage.sql.exec<{ status: string }>(`SELECT status FROM app_run_events WHERE id = 'probe:left'`).one()
  const recovery = storage.sql
    .exec<{ attributes: string }>(`SELECT attributes FROM app_run_events WHERE kind = 'recovery'`)
    .toArray()
    .map((row) => json(row.attributes))
  const problems = await inspect({ kind: 'problems' })
  return JSON.stringify({ rows, inspected, diagnosed, left: left.status, recovery, problems })
}
