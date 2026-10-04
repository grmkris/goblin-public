// A small ring for a fraction used (today's budget, the context), drawn in SVG. The arc is a dash whose length eases
// when the value changes. Past 90% the arc turns destructive; the label is for screen readers.
import { cn } from '../lib/cn'

const RADIUS = 7
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function UsageRing({
  value,
  label,
  className,
}: {
  /** 0 to 1; clamped. */
  readonly value: number
  readonly label: string
  readonly className?: string
}) {
  const fraction = Math.min(1, Math.max(0, value))
  return (
    <svg
      data-slot="usage-ring"
      data-full={fraction >= 0.9 || undefined}
      role="img"
      aria-label={label}
      viewBox="0 0 18 18"
      className={cn('group/usage-ring size-4.5 shrink-0 -rotate-90', className)}
    >
      <circle cx="9" cy="9" r={RADIUS} fill="none" strokeWidth="2.5" className="stroke-muted" />
      <circle
        cx="9"
        cy="9"
        r={RADIUS}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${(fraction * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
        className="stroke-muted-foreground transition-[stroke-dasharray] duration-500 ease-out group-data-full/usage-ring:stroke-destructive"
      />
    </svg>
  )
}

export { UsageRing }
