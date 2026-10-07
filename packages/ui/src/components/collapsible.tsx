// Ported from myapps' shadcn/ui base-nova collapsible (MIT), over Base UI's Collapsible.
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { cn } from '../lib/cn'

/**
 * A panel opens and closes with its height and a fade, 200ms in and 150ms out. Base UI measures the height into
 * `--collapsible-panel-height` for the transition and sets it back to auto once the panel is open, so content that grows
 * while open (thoughts still streaming) is never cut off. The panel clips while it moves, so padding belongs to what is
 * inside it, not to the panel.
 */
export const PANEL_MOTION =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-ending-style:duration-150 data-starting-style:h-0 data-starting-style:opacity-0 [&[hidden]:not([hidden='until-found'])]:hidden"

function Collapsible({ ...props }: CollapsiblePrimitive.Root.Props) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

function CollapsibleTrigger({ ...props }: CollapsiblePrimitive.Trigger.Props) {
  return <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="collapsible-content" className={cn(PANEL_MOTION, className)} {...props} />
  )
}

export { Collapsible, CollapsibleContent, CollapsibleTrigger }
