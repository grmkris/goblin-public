/** Fast 2xx after a verified event is durable; processing continues through waitUntil and the cron recovers misses. */
import { Clock, Effect, Exit, Layer } from 'effect'
import { runAtEdge } from '../http/api/edge.ts'
import { readBytes } from '../http/body.ts'
import { toAppError } from '../http/errors.ts'
import { LoggerLive } from '../observability/logger.ts'
import { ReporterLive, reportAndRecover } from '../observability/report.ts'
import { processStored, type BillingDeps } from './events.ts'

/**
 * The Worker waitUntil boundary owns this detached run; the inbox lease and cron own recovery, so a failure here is
 * reported and left to them.
 */
const processLater = (deps: BillingDeps, id: string, ctx: Pick<ExecutionContext, 'waitUntil'>): void => {
  const reported = processStored(deps, id).pipe(
    reportAndRecover('billing.webhook', undefined),
    Effect.provide(Layer.mergeAll(LoggerLive, ReporterLive)),
  )
  ctx.waitUntil(runAtEdge(reported))
}

export const billingWebhook = Effect.fn('billing.webhook')(function* (
  deps: BillingDeps | undefined,
  request: Request,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
) {
  if (deps === undefined) return Response.json({ error: 'billing_unavailable' }, { status: 503 })
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const bytes = yield* Effect.tryPromise({ try: () => readBytes(request, 262_144), catch: toAppError })
  const body = new TextDecoder().decode(bytes)
  const headers = {
    id: request.headers.get('webhook-id') ?? '',
    timestamp: request.headers.get('webhook-timestamp') ?? '',
    signature: request.headers.get('webhook-signature') ?? '',
  }
  const verified = yield* Effect.exit(deps.dodo.verify(headers, body, yield* Clock.currentTimeMillis))
  if (Exit.isFailure(verified)) return Response.json({ error: 'invalid_webhook' }, { status: 401 })
  const event = verified.value
  yield* deps.store.insertEvent(event, deps.dodo.mode, yield* Clock.currentTimeMillis)
  processLater(deps, event.id, ctx)
  return Response.json({ received: true })
})
