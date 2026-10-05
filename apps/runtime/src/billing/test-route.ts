/** Local harness only. This module is imported by the fixture Worker, never the deployed Worker. */
import { Clock, Effect, Schema } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import { readJson } from '../http/body.ts'
import { attempt } from '../services.ts'
import { processStored, type BillingDeps } from './events.ts'
import { planOf } from './reconcile.ts'
import { runBillingCron } from './cron.ts'

const Command = Schema.Struct({
  userId: Schema.String,
  eventId: Schema.optional(Schema.String),
  at: Schema.optional(Schema.Number),
  dailyTokens: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.String),
})
export const billingTestRoute = Effect.fn('billing.fixture')(function* (
  request: Request,
  env: RuntimeEnv,
  deps: BillingDeps,
) {
  const { userId, eventId, at, dailyTokens, body } = yield* attempt(() => readJson(request, Command))
  const action = new URL(request.url).pathname.split('/').at(-1)
  if (action === 'pending' && eventId !== undefined && body !== undefined) {
    const timestamp = String(Math.floor((yield* Clock.currentTimeMillis) / 1000))
    yield* deps.store.insertEvent(
      { id: eventId, type: 'subscription.active', timestamp: Number(timestamp) * 1000, data: {}, body },
      'test_mode',
      Number(timestamp) * 1000,
    )
    return Response.json({ ok: true })
  }
  if (action === 'process' && eventId !== undefined)
    return Response.json({ outcome: yield* processStored(deps, eventId) })
  if (action === 'inbox' && eventId !== undefined) return Response.json((yield* deps.store.inbox(eventId)) ?? null)
  if (action === 'cron') {
    yield* runBillingCron(deps)
    return Response.json({ ok: true })
  }
  if (action === 'override') {
    yield* attempt(() =>
      env.AUTH_DB.prepare(
        "INSERT INTO app_billing_accounts (user_id, plan_override, override_stage, daily_tokens, created_at, updated_at) VALUES (?, 'pro', 'test', ?, 0, 0) ON CONFLICT(user_id) DO UPDATE SET plan_override = 'pro', override_stage = 'test', daily_tokens = excluded.daily_tokens",
      )
        .bind(userId, dailyTokens ?? 100)
        .run(),
    )
    return Response.json({ ok: true })
  }
  if (action === 'as-prod') return Response.json(yield* planOf(deps.store, userId, 'prod', 'live_mode', at))
  return Response.json(yield* planOf(deps.store, userId, 'test', 'test_mode', at))
})
