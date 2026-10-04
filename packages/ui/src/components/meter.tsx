// A quantity within known bounds (today's model budget, how full the context is), on Base UI's Meter: a thin track
// whose fill glides when the value changes. Not a Progress: nothing here is "loading".
import { Meter as MeterPrimitive } from '@base-ui/react/meter'
import { cn } from '../lib/cn'

function Meter({ className, children, ...props }: MeterPrimitive.Root.Props) {
  return (
    <MeterPrimitive.Root data-slot="meter" className={cn('flex w-full min-w-0 flex-col gap-2', className)} {...props}>
      {children}
      <MeterPrimitive.Track data-slot="meter-track" className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <MeterPrimitive.Indicator
          data-slot="meter-indicator"
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
        />
      </MeterPrimitive.Track>
    </MeterPrimitive.Root>
  )
}

export { Meter }
