import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { type Args, UsageError, flagText, windowOf } from './args.ts'

/** How far back `goblin logs` looks without `--since`; Workers Logs keep seven days. */
const DEFAULT_SINCE = '24h'
const LIMIT = 200

export type LogQuery = { readonly worker: string; readonly needle: string; readonly from: number; readonly to: number }

/** A Workers Observability events query: one Worker's lines that mention `needle` (an operation or conversation id). */
export const logsQuery = (query: LogQuery) => ({
  queryId: 'goblin-cli-logs',
  timeframe: { from: query.from, to: query.to },
  view: 'events',
  limit: LIMIT,
  parameters: {
    filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: query.worker }],
    needle: { value: query.needle },
  },
})

const LogEvent = Schema.Struct({
  timestamp: Schema.Number,
  $metadata: Schema.optional(
    Schema.Struct({
      level: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      requestId: Schema.optional(Schema.String),
    }),
  ),
  source: Schema.optional(Schema.Unknown),
})
const LogsResponse = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  result: Schema.optional(
    Schema.Struct({ events: Schema.optional(Schema.Struct({ events: Schema.Array(LogEvent) })) }),
  ),
})
type LogEvent = typeof LogEvent.Type

/** One log line: when, level, request id, and the line itself (goblin's own lines are JSON). */
export const logLine = (event: LogEvent): string => {
  const meta = event.$metadata
  const body = event.source === undefined ? (meta?.message ?? '') : JSON.stringify(event.source)
  return [new Date(event.timestamp).toISOString(), meta?.level ?? '', meta?.requestId ?? '', body].join('  ')
}

const Credentials = Config.all({
  token: Config.Redacted('CLOUDFLARE_API_TOKEN'),
  account: Config.String('CLOUDFLARE_ACCOUNT_ID'),
})

/** The stage's Worker: `--worker`, or `goblin-<stage>` from the origin's own `/health`. */
async function workerOf(args: Args, origin: string): Promise<string> {
  const named = flagText(args, 'worker')
  if (named !== undefined) return named
  const health = Schema.decodeUnknownSync(Schema.Struct({ stage: Schema.String }))(
    await (await fetch(`${origin}/health`)).json(),
  )
  if (health.stage === 'local') throw new UsageError("A local stack's logs are in its own terminal.")
  return `goblin-${health.stage}`
}

/**
 * `goblin logs <id>`: the stage Worker's Workers Logs lines that mention an operation or conversation id, oldest
 * first. Reads Cloudflare with the operator's own `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the Worker never
 * sees them.
 */
export async function logs(args: Args, origin: string, now: number): Promise<string> {
  const needle = args.positionals[0]
  if (needle === undefined) throw new UsageError('goblin logs <operation or conversation id> [--since 6h]')
  const credentials = await Effect.runPromise(Credentials).catch(() => {
    throw new UsageError('goblin logs needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.')
  })
  const worker = await workerOf(args, origin)
  const from = now - windowOf(flagText(args, 'since') ?? DEFAULT_SINCE)
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${credentials.account}/workers/observability/telemetry/query`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Redacted.value(credentials.token)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(logsQuery({ worker, needle, from, to: now })),
    },
  )
  const body = Schema.decodeUnknownSync(LogsResponse)(await response.json())
  if (!body.success) throw new Error(`Cloudflare: ${(body.errors ?? []).map((error) => error.message).join('; ')}`)
  const events = [...(body.result?.events?.events ?? [])].toSorted((a, b) => a.timestamp - b.timestamp)
  return events.length === 0 ? `No ${worker} log lines mention ${needle}.` : events.map(logLine).join('\n')
}
