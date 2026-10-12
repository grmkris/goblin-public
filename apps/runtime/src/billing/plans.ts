/**
 * Adapted from myapps@8a69ec64: paid-through cancellation and bounded renewal grace, with no trial. A deployment may
 * give accounts without Pro a free plan (`FREE_DAILY_CREDITS`): the agent with fewer Credits, and routines that only
 * tell the owner (ADR 0012, amended 2026-10-12).
 */
export const PRO = {
  id: 'pro',
  priceCents: 1000,
  interval: 'monthly',
  /** Estimated Token Plan Credits a day (ADR 0026): about 2 million tokens at Alibaba's example rates. */
  dailyCredits: 800,
  routines: true,
  /** A routine may hand its work to Goblin or a Persona, which runs the agent (ADR 0041). */
  handOver: true,
  subagents: true,
} as const

/** A feature the plan gates: the agent itself, routines (Tell me), a routine's hand-over, and subagents. */
export type Feature = 'agent' | 'routines' | 'handOver' | 'subagents'

/**
 * What the free plan has of Pro's features: the agent, routines that tell the owner (Tell me: a notice in a Topic, and
 * on Telegram if they want, with no model call) and subagents, but no hand-over, which runs the agent on its own.
 */
const FREE: Readonly<Record<Feature, boolean>> = { agent: true, routines: true, handOver: false, subagents: true }

/** Whether the free plan includes `feature`; with none named, it is the agent. */
export const freeIncludes = (feature: Feature | undefined): boolean => FREE[feature ?? 'agent']

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
