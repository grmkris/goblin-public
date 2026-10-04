// A count that rolls its digits when it changes (NumberFlow): tabular, in the reader's locale, optionally compact
// (12.4K). It honours prefers-reduced-motion by default.
import NumberFlow from '@number-flow/react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const countVariants = cva('tabular-nums', {
  variants: {
    size: {
      default: '',
      /** The headline number of a card: larger, heavier, tighter tracking as the size grows. */
      display: 'text-2xl font-semibold tracking-tight text-foreground',
    },
  },
  defaultVariants: { size: 'default' },
})

function Count({
  value,
  compact = false,
  percent = false,
  size,
  className,
}: VariantProps<typeof countVariants> & {
  readonly value: number
  readonly compact?: boolean
  /** `value` is a fraction (0.38), shown as a whole percentage (38%). */
  readonly percent?: boolean
  readonly className?: string
}) {
  return (
    <NumberFlow
      data-slot="count"
      className={cn(countVariants({ size }), className)}
      value={value}
      format={
        percent
          ? { style: 'percent', maximumFractionDigits: 0 }
          : compact
            ? { notation: 'compact', maximumFractionDigits: 1 }
            : { maximumFractionDigits: 0 }
      }
    />
  )
}

export { Count }
