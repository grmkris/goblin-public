// The limits page's three meters: per payment, per hour and per week, as the owner set them in this wallet. Every
// other layer's limit (the chain's allowance, the signer's policy, the client's rule) stays listed in full below them.
import { usdToMicros } from '@goblin/wallet/amounts'
import type { LimitView } from '@goblin/wallet/contract'
import { shareUsed } from '../ui/limit-meter.tsx'
import { limitOrder } from '../views/overview-model.ts'

export type MeterPeriod = 'call' | 'hour' | 'week'

export interface Meter {
  readonly period: MeterPeriod
  readonly limit: LimitView
  /** What is left this period; undefined for a per-payment cap, which has no period to use up. */
  readonly left: string | undefined
  /** Percent of the period used, 0 to 100 to one decimal; a tiny use stays visible as a tiny share. */
  readonly used: number
}

const PERIODS: readonly MeterPeriod[] = ['call', 'hour', 'week']

/** What binds in a limit: what is left of its period, or the cap of a payment. */
const binding = (limit: LimitView): bigint => usdToMicros(limit.remaining ?? limit.limit)

const tighter = (a: LimitView, b: LimitView): LimitView => (binding(b) < binding(a) ? b : a)

/**
 * One meter per period: the wallet's own limit (the ledger's, the one the owner edits here) when it has one, otherwise
 * the tightest limit that applies on every network. A period nothing limits has no meter.
 */
export function metersOf(limits: readonly LimitView[]): readonly Meter[] {
  return PERIODS.flatMap((period) => {
    const of = limits.filter((limit) => limit.period === period).toSorted(limitOrder)
    const pick =
      of.find((limit) => limit.layer === 'ledger') ??
      of
        .filter((limit) => limit.chain === undefined)
        .reduce<LimitView | undefined>((best, limit) => (best === undefined ? limit : tighter(best, limit)), undefined)
    if (pick === undefined) return []
    const metered = period !== 'call' && pick.remaining !== undefined
    return [{ period, limit: pick, left: metered ? pick.remaining : undefined, used: metered ? shareUsed(pick) : 0 }]
  })
}
