// The composer's place when goblin cannot answer for want of a plan (ADR 0054, amended 2026-10-13: there is no free
// plan): a calm way to pick the day pass or monthly, or, for a day pass that could not take a day's payment, the way to
// add funds. Never the raw refusal; the message the owner wrote stays in the composer. It asks the model nothing.
import { useId } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import { failureCopy } from '@goblin/contracts/api'
import { Button, GoblinMark } from '@goblin/ui'
import { WalletIcon } from 'lucide-react'
import { useBilling } from '../account/hooks.ts'
import { dayPassFundsUrl, proPrices, unpaidDayPass, usd } from '../lib/pro.ts'

/**
 * What a message sent without a plan is refused with (`SubscriptionRequired` for `chat`), as the composer's notice
 * starts: the card says it calmly instead, so the dock leaves it out.
 */
export const PLAN_REFUSAL = failureCopy({
  _tag: 'SubscriptionRequired',
  subscribe: '/subscribe',
  feature: 'chat',
}).message

/** Whether goblin cannot answer for want of a plan: only once the plan is read and is none, never while it is read. */
export function usePlanNeeded(): boolean {
  const { state } = useBilling()
  return state !== undefined && !state.active
}

/** No plan: what goblin costs, and Pick a plan to start, which comes back here. */
export function PlanNeededCard() {
  const { state } = useBilling()
  const here = useRouterState({ select: (router) => router.location.href })
  const title = useId()
  if (state === undefined || state.active) return null
  const unpaid = unpaidDayPass(state)
  const fundsUrl = unpaid === undefined ? undefined : dayPassFundsUrl(unpaid, location.origin, here)
  const plans = <Link to="/subscribe" search={{ return: here }} />
  if (unpaid !== undefined && fundsUrl !== undefined)
    return (
      <section className="setup-card" aria-labelledby={title}>
        <p id={title} className="setup-card-title">
          <WalletIcon aria-hidden />
          Your day pass could not take {usd(unpaid.amountUsd)} for today
        </p>
        <p className="setup-card-why">
          Add funds to your Goblin Wallet, and goblin takes the day&apos;s {usd(unpaid.amountUsd)} and answers. Your
          message stays here.
        </p>
        <div className="card-actions">
          <Button size="sm" nativeButton={false} render={<a href={fundsUrl} />}>
            Add funds
          </Button>
          <Button size="sm" variant="ghost" nativeButton={false} render={plans}>
            Pick a plan
          </Button>
        </div>
      </section>
    )
  return (
    <section className="setup-card" aria-labelledby={title}>
      <p id={title} className="setup-card-title" data-tone="plan">
        <GoblinMark />
        goblin answers with Pro
      </p>
      <p className="setup-card-why">{proPrices(state.catalog)} Your message stays here.</p>
      <Button size="sm" nativeButton={false} render={plans}>
        Pick a plan to start
      </Button>
    </section>
  )
}
