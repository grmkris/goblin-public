// The smoke's release checks, apart from smoke-dev.ts, which runs on import: what the deploy built and shipped.
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { fileURLToPath } from 'node:url'
import { bundleCarries, releaseBuild } from './build-id.ts'
import type { DevClient } from './smoke-client.ts'
import { resolveStage } from './stage-config.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ASSET_TIMEOUT_MS = 30_000
/** How long a written point may take to show in Analytics Engine queries, and how often the smoke asks. */
const FLOWS_WAIT_MS = 120_000
const FLOWS_POLL_MS = 10_000

/**
 * The deployed client bundle names this checkout's commit (`VITE_GOBLIN_BUILD`, set by `stage.ts`), so the stage's
 * crash reports name their release. The local stack serves unbuilt source, which names none.
 */
export async function clientBuild(dev: DevClient, stage: string): Promise<string> {
  if (stage === 'local') return 'skipped: the local stack serves unbuilt source'
  const build = releaseBuild(ROOT)
  const page = await dev.send('/terms', { owner: false })
  if (!page.ok) throw new Error('client_page_unavailable')
  const read = async (path: string): Promise<string> => {
    const asset = await fetch(new URL(path, dev.origin), { signal: AbortSignal.timeout(ASSET_TIMEOUT_MS) })
    return asset.ok ? asset.text() : ''
  }
  if (!(await bundleCarries(await page.text(), build, read))) throw new Error('client_build_mismatch')
  return build
}

/**
 * The SQL that counts the stage's `send` points of the last `minutes` in its flows dataset. Blob positions follow the
 * point layout in apps/runtime/src/observability/ae.ts (blob1 the flow, blob7 the stage).
 */
export function sendPointsQuery(stage: string, minutes: number): string {
  const { name, resourceName } = resolveStage(stage)
  return [
    'SELECT SUM(_sample_interval) AS points',
    `FROM "${resourceName('flows')}"`,
    `WHERE timestamp > NOW() - INTERVAL '${Math.max(1, Math.ceil(minutes))}' MINUTE`,
    `  AND blob1 = 'send' AND blob7 = '${name}'`,
    'FORMAT JSON',
  ].join('\n')
}

const PointsResponse = Schema.Struct({
  data: Schema.Array(Schema.Struct({ points: Schema.NullOr(Schema.Union([Schema.Number, Schema.NumberFromString])) })),
})
/** How many points an Analytics Engine answer to `sendPointsQuery` counts. */
export const pointsOf = (body: unknown): number =>
  Schema.decodeUnknownSync(PointsResponse)(body).data.reduce((sum, row) => sum + (row.points ?? 0), 0)

const Credentials = Config.all({
  token: Config.option(Config.Redacted('CLOUDFLARE_API_TOKEN')),
  account: Config.option(Config.String('CLOUDFLARE_ACCOUNT_ID')),
})

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

/**
 * The smoke's own sends reached the stage's Analytics Engine flows dataset (ADR 0037): a `send` point written since
 * `since`. It reads with the operator's own `CLOUDFLARE_API_TOKEN` (Account Analytics read) and
 * `CLOUDFLARE_ACCOUNT_ID`, as `goblin stats` does, and records why it was skipped when they are not set or cannot read.
 */
export async function flowsCheck(stage: string, since: number): Promise<string> {
  if (stage === 'local') return 'skipped: the local stack writes no Analytics Engine points'
  const { token, account } = await Effect.runPromise(Credentials)
  if (Option.isNone(token) || Option.isNone(account))
    return 'skipped: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set'
  const url = `https://api.cloudflare.com/client/v4/accounts/${account.value}/analytics_engine/sql`
  const deadline = Date.now() + FLOWS_WAIT_MS
  while (Date.now() < deadline) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${Redacted.value(token.value)}` },
      body: sendPointsQuery(stage, (Date.now() - since) / 60_000 + 1),
      signal: AbortSignal.timeout(FLOWS_POLL_MS * 3),
    })
    if (response.status === 401 || response.status === 403)
      return `skipped: the token cannot read Analytics Engine (${response.status})`
    if (!response.ok) throw new Error(`flows_query_failed: ${response.status}`)
    if (pointsOf(await response.json()) > 0) return 'ok'
    await wait(FLOWS_POLL_MS)
  }
  throw new Error('flows_point_missing')
}
