/** Fast 2xx after a verified event is durable; processing continues through waitUntil and the cron recovers misses. */
import { Clock, Effect, Exit } from 'effect'
import { readBytes } from '../http/body.ts'
import { attempt } from '../services.ts'
import { processStored, type BillingDeps } from './events.ts'

/** The Worker waitUntil boundary owns this detached run; the inbox lease and cron own recovery. */
const processLater = (deps: BillingDeps, id: string, ctx: Pick<ExecutionContext, 'waitUntil'>): void => {
  ctx.waitUntil(Effect.runPromise(processStored(deps, id)).catch(() => undefined))
}

export const billingWebhook = Effect.fn('billing.webhook')(function* (
  deps: BillingDeps | undefined,
  request: Request,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
) {
  if (deps === undefined) return Response.json({ error: 'billing_unavailable' }, { status: 503 })
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  const body = new TextDecoder().decode(yield* attempt(() => readBytes(request, 262_144)))
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
