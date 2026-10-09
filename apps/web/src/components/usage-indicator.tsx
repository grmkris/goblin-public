import type { UsageToday } from '@goblin/contracts'
import { Count, Popover, PopoverContent, PopoverTrigger, UsageRing } from '@goblin/ui'
import { budgetFraction } from '../lib/usage.ts'

/**
 * How much of today's model budget is spent (the ring) and, in a wide pane, how full the conversation's context is.
 * The numbers roll when a turn ends rather than with every streamed token. The figures in words open on hover, or on a
 * tap where there is no hover (a phone shows the ring alone, and had no way to read them).
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
  const budget = `${Math.round(today * 100)}% of today's model budget used`
  const of = contextWindow === undefined ? '' : ` of ${contextWindow.toLocaleString()}`
  const tokens = context === undefined ? undefined : `${context.toLocaleString()} tokens in context${of}`
  const label = tokens === undefined ? budget : `${budget}; ${tokens}`
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={400}
        render={<button type="button" className="usage-indicator" aria-label={label} />}
      >
        <UsageRing value={today} label={label} />
        <span className="usage-figures" aria-hidden>
          <Count value={today} percent /> today
          {context !== undefined && (
            <>
              <span>·</span>
              <Count value={context} compact /> in context
            </>
          )}
        </span>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-auto max-w-72">
        <p>{budget}</p>
        {tokens !== undefined && <p className="text-muted-foreground">{tokens}</p>}
        <p className="text-xs text-muted-foreground">It starts again at 00:00 UTC.</p>
      </PopoverContent>
    </Popover>
  )
}
