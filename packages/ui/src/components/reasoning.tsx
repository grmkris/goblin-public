// The model's visible thinking, kept out of the way: one muted line that opens to the text. While the model is still
// thinking the label shimmers (a static label under reduced motion).
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '../lib/cn'

function Reasoning({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="reasoning"
      className={cn('group/reasoning flex w-full min-w-0 flex-col text-sm', className)}
      {...props}
    />
  )
}

function ReasoningTrigger({
  className,
  children,
  live = false,
  ...props
}: CollapsiblePrimitive.Trigger.Props & { readonly live?: boolean }) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="reasoning-trigger"
      data-live={live || undefined}
      className={cn(
        'inline-flex min-h-8 w-fit items-center gap-1 rounded-md px-1 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-live:animate-pulse pointer-coarse:min-h-11',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 transition-transform duration-200 group-data-open/reasoning:rotate-90"
      />
    </CollapsiblePrimitive.Trigger>
  )
}

function ReasoningContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="reasoning-content"
      className={cn(
        'ml-2 border-l-2 border-border py-1 pl-3 leading-relaxed whitespace-pre-wrap text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export { Reasoning, ReasoningContent, ReasoningTrigger }
