/**
 * Adapted from myapps@8a69ec64: paid-through cancellation and bounded renewal grace, with no trial. A deployment may
 * give accounts without Pro a free plan (`FREE_DAILY_CREDITS`): the agent with fewer Credits, and no routines.
 */
export const PRO = {
  id: 'pro',
  priceCents: 1000,
  interval: 'monthly',
  /** Estimated Token Plan Credits a day (ADR 0026): about 2 million tokens at Alibaba's example rates. */
  dailyCredits: 800,
  routines: true,
  subagents: true,
} as const
/** What the free plan leaves out: routines (and so Telegram notices, which run as routines). */
export const FREE = { id: 'free', routines: false } as const

/** The free plan's daily Credits from the deployment's setting: a whole number up to Pro's, else none. */
export const freeCredits = (value: string | undefined): number => {
  const credits = Number(value ?? '0')
  return Number.isInteger(credits) && credits > 0 ? Math.min(credits, PRO.dailyCredits) : 0
}
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
