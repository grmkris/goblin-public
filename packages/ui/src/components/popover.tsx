// Ported from myapps' shadcn/ui base-nova popover (MIT), over Base UI's Popover. `size="panel"` is a settings panel:
// as wide as a phone allows, as tall as the space beside its trigger, scrolling inside.
import * as React from 'react'
import { Popover as PopoverPrimitive } from '@base-ui/react/popover'
import { cn } from '../lib/cn'

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** 8px from each edge plus the app's safe area (`--safe-top` and friends), as the dropdown menu keeps. */
function edgePadding() {
  const style = typeof document === 'undefined' ? null : getComputedStyle(document.documentElement)
  const safe = (edge: string) => (style ? Number.parseFloat(style.getPropertyValue(`--safe-${edge}`)) || 0 : 0)
  return { top: 8 + safe('top'), right: 8 + safe('right'), bottom: 8 + safe('bottom'), left: 8 + safe('left') }
}

function PopoverContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 4,
  anchor,
  size = 'default',
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset' | 'anchor'> & {
    readonly size?: 'default' | 'panel'
  }) {
  const padding = React.useMemo(() => edgePadding(), [])
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={padding}
        anchor={anchor}
        className="isolate z-(--z-overlay)"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          data-size={size}
          className={cn(
            'z-(--z-overlay) flex w-72 origin-(--transform-origin) flex-col gap-2.5 rounded-lg bg-popover p-2.5 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden transition-[scale,opacity] duration-150 data-ending-style:duration-100 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-[size=panel]:max-h-[min(32rem,var(--available-height))] data-[size=panel]:w-[min(22rem,calc(100vw-1rem))] data-[size=panel]:overflow-y-auto data-[size=panel]:overscroll-contain data-[size=panel]:rounded-xl data-[size=panel]:p-1.5',
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="popover-header" className={cn('flex flex-col gap-0.5 text-sm', className)} {...props} />
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn('font-medium', className)} {...props} />
}

function PopoverDescription({ className, ...props }: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn('text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger }
