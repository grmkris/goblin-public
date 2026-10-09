import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { type Args, UsageError, flagText, windowOf } from './args.ts'
import { cloudflareCredentials, workerOf } from './logs.ts'

/** How far back `goblin stats` looks without `--since`. */
const DEFAULT_SINCE = '24h'
/** Dataset names are the stage's resource names (`goblin-<stage>-flows`); anything else is refused, never quoted in. */
const DATASET = /^[a-z0-9-]{1,64}$/u

/**
 * Conversation flows across every agent of the stage (ADR 0037), one row per flow and outcome: steps, distinct agents
 * (by their hashed id) and mean duration, weighted by Analytics Engine's sample interval. Blob and double positions
 * follow the point layout in apps/runtime/src/observability/ae.ts.
 */
export const statsQuery = (dataset: string, minutes: number): string => {
  if (!DATASET.test(dataset)) throw new UsageError(`not a dataset name: ${dataset}`)
  return [
    'SELECT blob1 AS flow, blob5 AS status, SUM(_sample_interval) AS steps, COUNT(DISTINCT index1) AS agents,',
    '  SUM(_sample_interval * double3) / SUM(_sample_interval) AS avg_ms',
    `FROM "${dataset}"`,
    `WHERE timestamp > NOW() - INTERVAL '${Math.max(1, Math.round(minutes))}' MINUTE`,
    'GROUP BY flow, status',
    'ORDER BY steps DESC',
    'LIMIT 200',
    'FORMAT JSON',
  ].join('\n')
}

const StatsRow = Schema.Struct({
  flow: Schema.String,
  status: Schema.String,
  steps: Schema.Union([Schema.Number, Schema.NumberFromString]),
  agents: Schema.Union([Schema.Number, Schema.NumberFromString]),
  avg_ms: Schema.Union([Schema.Number, Schema.NumberFromString, Schema.Null]),
})
const StatsResponse = Schema.Struct({ data: Schema.Array(StatsRow) })
type StatsRow = typeof StatsRow.Type

/** One row in a line: flow, outcome, steps, agents and mean duration. */
export const statsLine = (row: StatsRow): string =>
  [
    row.flow.padEnd(19),
    row.status.padEnd(8),
    `${Math.round(row.steps)} steps`.padStart(12),
    `${Math.round(row.agents)} agents`.padStart(11),
    row.avg_ms === null ? '' : `${Math.round(row.avg_ms)}ms avg`,
  ].join('  ')

/**
 * `goblin stats [--since 24h] [--dataset name]`: flow totals across agents from the stage's Analytics Engine dataset,
 * through the Analytics Engine SQL API with your own `CLOUDFLARE_API_TOKEN` (it needs Account Analytics read) and
 * `CLOUDFLARE_ACCOUNT_ID`. The token is sent to Cloudflare only and never printed.
 */
export async function stats(args: Args, origin: string): Promise<string> {
  const credentials = await cloudflareCredentials('stats')
  const dataset = flagText(args, 'dataset') ?? `${await workerOf(args, origin)}-flows`
  const minutes = windowOf(flagText(args, 'since') ?? DEFAULT_SINCE) / 60_000
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.account}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${Redacted.value(credentials.token)}` },
      body: statsQuery(dataset, minutes),
    },
  )
  if (!response.ok)
    throw new Error(
      `Analytics Engine answered ${response.status}${response.status === 403 ? ': the token needs Account Analytics read' : ''}`,
    )
  const { data } = Schema.decodeUnknownSync(StatsResponse)(await response.json())
  return data.length === 0 ? `No flows in ${dataset} in that window.` : data.map(statsLine).join('\n')
}
