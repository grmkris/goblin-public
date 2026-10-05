import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyStandardWebhook } from '../src/billing/standard-webhooks.ts'
import { subscriptionAccessUntil } from '../src/billing/plans.ts'
const KEY = 'whsec_Zml4dHVyZS1iaWxsaW5nLXNpZ25pbmcta2V5'
const NOW = Date.UTC(2026, 9, 5)
const BODY = JSON.stringify({ type: 'subscription.active', data: {} })
const headers = (timestamp = NOW / 1000) => ({
  id: 'fixture-id',
  timestamp: String(timestamp),
  signature: `v1,${createHmac('sha256', Buffer.from(KEY.slice(6), 'base64'))
    .update(`fixture-id.${timestamp}.${BODY}`)
    .digest('base64')}`,
})
describe('billing webhook verification', () => {
  it('accepts one matching signature and rejects tampered body, id, key and stale/future timestamps', async () => {
    const h = headers()
    expect(await verifyStandardWebhook(KEY, h, BODY, NOW)).toBe(true)
    expect(await verifyStandardWebhook(KEY, { ...h, signature: `v2,nope v1,AAAA ${h.signature}` }, BODY, NOW)).toBe(
      true,
    )
    for (const invalid of [
      { ...h, id: 'other' },
      { ...h, signature: 'v1,%%%' },
      headers(NOW / 1000 - 301),
      headers(NOW / 1000 + 301),
      { ...h, timestamp: 'later' },
    ])
      expect(await verifyStandardWebhook(KEY, invalid, BODY, NOW)).toBe(false)
    expect(await verifyStandardWebhook(KEY, h, `${BODY} `, NOW)).toBe(false)
    expect(await verifyStandardWebhook('whsec_d3Jvbmc=', h, BODY, NOW)).toBe(false)
  })
  it('keeps paid-through cancellation and provider/fallback grace; missing or expired periods grant nothing', () => {
    const end = NOW + 1000
    expect(subscriptionAccessUntil({ status: 'cancelled', periodEnd: end, pastDueEndsAt: null }, NOW)).toBe(end)
    expect(subscriptionAccessUntil({ status: 'cancelled', periodEnd: end, pastDueEndsAt: null }, end)).toBeNull()
    expect(subscriptionAccessUntil({ status: 'past_due', periodEnd: NOW, pastDueEndsAt: null }, NOW)).toBe(
      NOW + 3 * 86_400_000,
    )
    expect(subscriptionAccessUntil({ status: 'on_hold', periodEnd: NOW, pastDueEndsAt: end }, NOW)).toBe(end)
    expect(subscriptionAccessUntil({ status: 'active', periodEnd: null, pastDueEndsAt: null }, NOW)).toBeNull()
  })
})
