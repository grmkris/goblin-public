// Ported from shadcn/ui's base-nova hover-card (MIT), over Base UI's PreviewCard: what a compact control is, shown
// while the pointer rests on it (and on keyboard focus). Never the only way to learn something; it repeats a label.
import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card'
import { cn } from '../lib/cn'

function HoverCard({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />
}

function HoverCardTrigger({ delay = 250, closeDelay = 100, ...props }: PreviewCardPrimitive.Trigger.Props) {
  return (
    <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" delay={delay} closeDelay={closeDelay} {...props} />
  )
}

function HoverCardContent({
  className,
  side = 'right',
  sideOffset = 8,
  align = 'start',
  ...props
}: PreviewCardPrimitive.Popup.Props & Pick<PreviewCardPrimitive.Positioner.Props, 'side' | 'sideOffset' | 'align'>) {
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner side={side} sideOffset={sideOffset} align={align} className="isolate z-50">
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            'z-50 flex w-64 origin-(--transform-origin) flex-col gap-1 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition-[scale,opacity] duration-150 data-ending-style:duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0',
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  )
}

export { HoverCard, HoverCardContent, HoverCardTrigger }
