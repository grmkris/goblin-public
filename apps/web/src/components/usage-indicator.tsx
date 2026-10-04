import type { UsageToday } from '@purrable/contracts'
import { Count, UsageRing } from '@purrable/ui'
import { budgetFraction } from '../lib/usage.ts'

/**
 * How much of today's model budget is spent (the ring) and, on wider screens, how full the conversation's context
 * is. The numbers roll when a turn ends rather than with every streamed token.
 */
export function UsageIndicator({
  usage,
  context,
  contextWindow,
}: {
  readonly usage: UsageToday | undefined
  readonly context: number | undefined
  readonly contextWindow: number | undefined
}) {
  if (usage === undefined) return null
  const today = budgetFraction(usage)
  const label = `${Math.round(today * 100)}% of today's model budget used${
    context === undefined
      ? ''
      : `; ${context.toLocaleString()} tokens in context${contextWindow === undefined ? '' : ` of ${contextWindow.toLocaleString()}`}`
  }`
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" title={label}>
      <UsageRing value={today} label={label} />
      <span className="hidden items-center gap-1 md:flex" aria-hidden>
        <Count value={today} percent /> today
        {context !== undefined && (
          <>
            <span>·</span>
            <Count value={context} compact /> in context
          </>
        )}
      </span>
    </span>
  )
}
