import { PRIMARY_CHAT } from '@goblin/contracts'
import { RunAttribute } from '@goblin/contracts/telemetry'
import type { InspectQuery } from '@goblin/contracts/inspect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { flowRunEvent } from '../../src/telemetry/events.ts'
import { runTelemetry } from '../../src/telemetry/run.ts'

type Row = { kind: string; status: string; operation_id: string | null; attributes: string }
const json = (text: string): unknown => JSON.parse(text)

/** The answer entry Pi settled a turn with, from an encoded `turn` timeline. */
const answerOf = (encoded: unknown): number | undefined =>
  Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Struct({ value: Schema.Struct({ submission: Schema.Struct({ answer: Schema.Number }) }) }),
    )(encoded),
  )?.value.submission.answer

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
  await turn('call subagent_status {}', 'telemetry-turn')
  const rows = storage.sql
    .exec<Row>(
      'SELECT kind, status, operation_id, attributes FROM app_run_events WHERE operation_id = ? ORDER BY started_at, id',
      'telemetry-turn',
    )
    .toArray()
    .map((row) => ({ kind: row.kind, status: row.status, attributes: json(row.attributes) }))
  const inspected = {
    turn: await inspect({ kind: 'turn', operationId: 'telemetry-turn' }),
    turns: await inspect({ kind: 'turns', conversation: PRIMARY_CHAT }),
    conversation: await inspect({ kind: 'conversation', conversation: PRIMARY_CHAT }),
    missing: await inspect({ kind: 'turn', operationId: 'no-such-turn' }),
    invalid: await inspect({ kind: 'everything' }),
  }
  // A message's details (ADR 0037): the turn by its operation and by its answer's entry, and what it caused, on the
  // agent's own SQLite (json_extract and LIKE … ESCAPE in workerd): a thread it started, a Persona's answer to it.
  const links = runTelemetry(storage, () => owner).telemetry
  const linkedAt = Date.now()
  links.record(
    flowRunEvent(
      {
        flow: 'start',
        via: 'app',
        actor: 'owner',
        chat: PRIMARY_CHAT,
        operationId: 'telemetry-thread',
        parentOperation: 'telemetry-turn',
        status: 'ok',
      },
      'flow:telemetry-thread',
      linkedAt,
    ),
  )
  links.record({
    id: 'turn:telemetry-persona',
    kind: 'turn.submitted',
    status: 'ok',
    operationId: 'persona:telemetry-turn:7',
    startedAt: linkedAt,
    endedAt: linkedAt,
    attributes: {},
  })
  const answer = answerOf(inspected.turn)
  const details = {
    byOperation: await inspect({ kind: 'details', operation: 'telemetry-turn' }),
    byEntry: await inspect({ kind: 'details', chat: PRIMARY_CHAT, entry: answer ?? 0 }),
    thread: await inspect({ kind: 'details', operation: 'telemetry-thread' }),
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
  const seed = runTelemetry(storage, () => owner).telemetry
  const at = Date.now()
  seed.record({
    id: 'filter:aux-failure',
    kind: 'model.aux',
    status: 'error',
    startedAt: at,
    endedAt: at,
    attributes: { [RunAttribute.purpose]: 'memory', [RunAttribute.errorType]: 'provider_error' },
  })
  const record = (
    id: string,
    status: 'ok' | 'error' | 'blocked',
    offset: number,
    attributes: Record<string, string | number | boolean>,
  ) =>
    seed.record({
      id,
      kind: 'model.attempt',
      status,
      startedAt: at + offset,
      endedAt: at + offset,
      operationId: 'filter-fixture',
      taskId: id === 'filter:failure' || id === 'filter:success' ? 'retry-task' : id,
      attributes,
    })
  record('filter:unresolved', 'error', 1, {
    [RunAttribute.errorType]: 'provider_error',
    [RunAttribute.error]: 'PRIVATE_NATIVE_PAYLOAD',
  })
  record('filter:failure', 'error', 2, { [RunAttribute.errorType]: 'provider_error' })
  record('filter:success', 'ok', 3, { [RunAttribute.finishReason]: 'stop' })
  record('filter:authorization', 'blocked', 4, { [RunAttribute.errorType]: 'NeedsAuthorization' })
  const attention = await inspect({ kind: 'problems', since: at, limit: 1 })
  record('filter:cutoff', 'ok', 5, { [RunAttribute.finishReason]: 'length', [RunAttribute.cutoff]: true })
  record('filter:empty', 'ok', 6, { [RunAttribute.emptyAnswer]: true })
  record('filter:gap', 'ok', 7, { [RunAttribute.coverageGap]: true })
  const all = await inspect({ kind: 'problems', since: at, all: true, limit: 10 })
  const incomplete = await inspect({ kind: 'problems', since: at, limit: 10 })
  // More than one query page, with tied timestamps: noise cannot hide the older actionable rows.
  for (let index = 0; index < 105; index++)
    record(`filter:wait-${index.toString().padStart(3, '0')}`, 'blocked', 8, {
      [RunAttribute.errorType]: 'NeedsAuthorization',
    })
  // Successful bounded memory completions must not fill either problems view.
  for (let index = 0; index < 105; index++)
    seed.record({
      id: `filter:aux-${index.toString().padStart(3, '0')}`,
      kind: 'model.aux',
      status: 'ok',
      startedAt: at + 9,
      endedAt: at + 9,
      attributes: {
        [RunAttribute.purpose]: 'memory',
        [RunAttribute.finishReason]: 'length',
        [RunAttribute.cutoff]: true,
      },
    })
  const paged = await inspect({ kind: 'problems', since: at, limit: 10 })
  const pagedAll = await inspect({ kind: 'problems', since: at, all: true, limit: 3 })
  return JSON.stringify({
    rows,
    inspected,
    details,
    diagnosed,
    left: left.status,
    recovery,
    problems,
    attention,
    all,
    incomplete,
    paged,
    pagedAll,
  })
}
