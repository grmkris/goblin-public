/** Adapted from myapps@8a69ec64: paid-through cancellation and bounded renewal grace, with no free tier or trial. */
export const PRO = {
  id: 'pro',
  priceCents: 1000,
  interval: 'monthly',
  /** Estimated Token Plan Credits a day (ADR 0026): about 2 million tokens at Alibaba's example rates. */
  dailyCredits: 800,
  routines: true,
  subagents: true,
} as const
const MISSING_GRACE_MS = 3 * 86_400_000
export interface SubscriptionFacts {
  readonly status: string
  readonly periodEnd: number | null
  readonly pastDueEndsAt: number | null
}
export const subscriptionAccessUntil = (row: SubscriptionFacts, now: number): number | null => {
  if (row.status === 'active' || row.status === 'cancelled')
    return row.periodEnd !== null && row.periodEnd > now ? row.periodEnd : null
  if (row.status === 'past_due' || row.status === 'on_hold') {
    const end = row.pastDueEndsAt ?? (row.periodEnd === null ? null : row.periodEnd + MISSING_GRACE_MS)
    return end !== null && end > now ? end : null
  }
  return null
}
