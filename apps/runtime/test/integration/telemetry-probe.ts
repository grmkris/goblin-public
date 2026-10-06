import { agentTelemetry } from '../../src/telemetry/agent.ts'

type Row = { kind: string; status: string; operation_id: string | null; attributes: string }
const json = (text: string): unknown => JSON.parse(text)

/**
 * The run ledger on the agent's real SQLite (ADR 0024): one owner turn with a tool call, the rows it left for that
 * operation, then the restart sweep interrupting a row left started. As JSON text.
 */
export async function telemetryProbe(
  storage: DurableObjectStorage,
  owner: string,
  turn: (text: string, operationId: string) => Promise<unknown>,
): Promise<string> {
  await turn('call subagent {"action":"status"}', 'telemetry-turn')
  const rows = storage.sql
    .exec<Row>(
      'SELECT kind, status, operation_id, attributes FROM app_run_events WHERE operation_id = ? ORDER BY started_at, id',
      'telemetry-turn',
    )
    .toArray()
    .map((row) => ({ kind: row.kind, status: row.status, attributes: json(row.attributes) }))
  storage.sql.exec(
    `INSERT INTO app_run_events (id, kind, status, started_at, attributes) VALUES ('probe:left', 'tool.call', 'started', ?, '{}')`,
    Date.now(),
  )
  agentTelemetry(storage, () => owner).restarted(Date.now())
  const left = storage.sql.exec<{ status: string }>(`SELECT status FROM app_run_events WHERE id = 'probe:left'`).one()
  const recovery = storage.sql
    .exec<{ attributes: string }>(`SELECT attributes FROM app_run_events WHERE kind = 'recovery'`)
    .toArray()
    .map((row) => json(row.attributes))
  return JSON.stringify({ rows, left: left.status, recovery })
}
