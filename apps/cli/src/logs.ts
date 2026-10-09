import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
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
export type LogEvent = typeof LogEvent.Type

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

/** Your Cloudflare token and account from the environment; the token stays redacted until a request needs it. */
export async function cloudflareCredentials(command: string) {
  return Effect.runPromise(Credentials).catch(() => {
    throw new UsageError(`goblin ${command} needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.`)
  })
}

/** The stage's Worker: `--worker`, or `goblin-<stage>` from the origin's own `/health`. */
export async function workerOf(args: Args, origin: string): Promise<string> {
  const named = flagText(args, 'worker')
  if (named !== undefined) return named
  const health = Schema.decodeUnknownSync(Schema.Struct({ stage: Schema.String }))(
    await (await fetch(`${origin}/health`)).json(),
  )
  if (health.stage === 'local') throw new UsageError("A local stack's logs are in its own terminal.")
  return `goblin-${health.stage}`
}

/**
 * The stage Worker's Workers Logs lines that mention `needle`, oldest first, over `--since` (a day by default). Reads
 * Cloudflare with your own `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the Worker never sees them.
 */
export async function searchLogs(
  args: Args,
  origin: string,
  now: number,
  needle: string,
  command: string,
): Promise<{ readonly worker: string; readonly events: readonly LogEvent[] }> {
  const credentials = await cloudflareCredentials(command)
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
  return { worker, events: [...(body.result?.events?.events ?? [])].toSorted((a, b) => a.timestamp - b.timestamp) }
}

/** `goblin logs <id>`: the stage Worker's log lines that mention an operation or conversation id, oldest first. */
export async function logs(args: Args, origin: string, now: number): Promise<string> {
  const needle = args.positionals[0]
  if (needle === undefined) throw new UsageError('goblin logs <operation or conversation id> [--since 6h]')
  const { worker, events } = await searchLogs(args, origin, now, needle, 'logs')
  return events.length === 0 ? `No ${worker} log lines mention ${needle}.` : events.map(logLine).join('\n')
}

/** The operation a goblin JSON line names, under either key its writers use. */
const Named = Schema.Struct({
  operation: Schema.optional(Schema.String),
  'goblin.operation': Schema.optional(Schema.String),
})
const namedOf = Schema.decodeUnknownOption(Named)

/** The operation ids goblin's own JSON lines name (`operation`, `goblin.operation`), in the order they appear. */
export function operationsOf(events: readonly LogEvent[]): string[] {
  const named = events.flatMap((event) => {
    const fields = Option.getOrUndefined(namedOf(event.source))
    return [fields?.operation, fields?.['goblin.operation']].filter(
      (operation): operation is string => operation !== undefined && operation !== '',
    )
  })
  return [...new Set(named)]
}
