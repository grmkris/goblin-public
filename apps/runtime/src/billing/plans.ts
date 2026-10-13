/**
 * goblin Pro (ADR 0015, 0054): the one plan, with every feature. It is paid from the Goblin Wallet by a day pass or
 * monthly (or by card, while the deployment turns that on). There is no free plan: an account without Pro is refused
 * chat (ADR 0054, amended 2026-10-13). The prices are the deployment's setting, `GOBLIN_PLAN_CATALOG`, over the
 * defaults here.
 *
 * Adapted from myapps@8a69ec64: paid-through cancellation and bounded renewal grace, with no trial.
 */
import { type BillingId, PlanCatalogSetting, type PlanOffer } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/** A feature the plan gates: the agent itself, routines (Tell me), a routine's hand-over, and subagents. */
export type Feature = 'agent' | 'routines' | 'handOver' | 'subagents'

/** The ways to pay for Pro on a deployment, with their prices and Credits. */
export type PlanCatalog = Readonly<Record<BillingId, PlanOffer>>

/**
 * The defaults (Kris, 2026-10-13): the day pass is $1 for each UTC day the owner uses goblin, monthly $15 every 30 days.
 * Either gives Pro's 800 Credits a day, about 2 million tokens at Alibaba's example rates (ADR 0026).
 */
export const DEFAULT_CATALOG: PlanCatalog = {
  day: { id: 'day', amountUsd: '1.00', periodDays: 1, dailyCredits: 800 },
  month: { id: 'month', amountUsd: '15.00', periodDays: 30, dailyCredits: 800 },
}

/** How long a subscription the owner signs runs, whichever way they pay: twelve months. */
export const SUBSCRIPTION_MONTHS = 12

const decodeSetting = Schema.decodeUnknownOption(Schema.fromJsonString(PlanCatalogSetting))

/**
 * The deployment's catalog: `GOBLIN_PLAN_CATALOG` over the defaults, field by field. A setting that does not decode
 * keeps the defaults; the deploy refuses one (`apps/web/alchemy.run.ts`), so a running Worker never meets it.
 */
export const planCatalog = (value: string | undefined): PlanCatalog => {
  if (value === undefined || value.trim() === '') return DEFAULT_CATALOG
  const setting = Option.getOrUndefined(decodeSetting(value))
  if (setting === undefined) return DEFAULT_CATALOG
  return {
    day: { ...DEFAULT_CATALOG.day, ...setting.day },
    month: { ...DEFAULT_CATALOG.month, ...setting.month },
  }
}

/** The catalog as the owner reads it: the day pass first. */
export const catalogOffers = (catalog: PlanCatalog): readonly PlanOffer[] => [catalog.day, catalog.month]

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
