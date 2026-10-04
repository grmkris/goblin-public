// A duration that rolls its digits as it changes (NumberFlow). While something runs it counts whole seconds; once
// settled it shows one decimal. NumberFlow honours prefers-reduced-motion by default; digits are tabular.
import NumberFlow from '@number-flow/react'
import { cn } from '../lib/cn'

function Duration({
  ms,
  running = false,
  className,
}: {
  readonly ms: number
  readonly running?: boolean
  readonly className?: string
}) {
  const seconds = Math.max(0, ms) / 1000
  const minutes = seconds >= 60
  return (
    <NumberFlow
      data-slot="duration"
      className={cn('tabular-nums', className)}
      value={minutes ? seconds / 60 : running ? Math.floor(seconds) : seconds}
      format={{ maximumFractionDigits: running && !minutes ? 0 : 1 }}
      suffix={minutes ? 'm' : 's'}
      willChange={running}
    />
  )
}

export { Duration }
