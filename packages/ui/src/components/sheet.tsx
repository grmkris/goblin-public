// Adapted from grmkris/myapps packages/ui/src/components/sheet.tsx (8bb08f1), with its keyboard-aware bottom sheet
// (content-sized; the `full` size is left out) and goblin's `pane` variant for sheets opened from the side.
import * as React from 'react'
import { Dialog as SheetPrimitive } from '@base-ui/react/dialog'
import { XIcon } from 'lucide-react'
import { cn } from '../lib/cn'
import { Button } from './button'

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs',
        className,
      )}
      {...props}
    />
  )
}

/**
 * A bottom sheet slides up from the bottom edge and back down the way it came, on the drawer curve, without fading.
 * It rests on the software keyboard instead of under it: `--keyboard-inset` (the strip the keyboard
 * covers, where a page publishes it; 0 otherwise) lifts it and comes off its height, and its bottom padding clears the
 * home indicator. A call site's own `max-h-*`, `h-*` or padding wins.
 */
const BOTTOM_SHEET =
  'data-starting-style:opacity-100 data-ending-style:opacity-100 bottom-(--keyboard-inset,0px) h-auto max-h-[calc(100dvh-6rem-var(--keyboard-inset,0px))] rounded-t-xl pr-[env(safe-area-inset-right)] pb-[max(0px,calc(env(safe-area-inset-bottom)-var(--keyboard-inset,0px)))] pl-[env(safe-area-inset-left)]'

/**
 * `pane` holds a whole view of its own (a thread beside the chat): the full width of a phone, a column above it,
 * sliding fully in from its edge on the sheet curve instead of the default nudge and fade.
 */
const PANE =
  'gap-0 bg-background p-0 data-ending-style:opacity-100 data-starting-style:opacity-100 data-[side=left]:w-full data-[side=right]:w-full data-[side=left]:sm:max-w-md data-[side=right]:sm:max-w-md data-[side=left]:data-ending-style:-translate-x-full data-[side=left]:data-starting-style:-translate-x-full data-[side=right]:data-ending-style:translate-x-full data-[side=right]:data-starting-style:translate-x-full'

function SheetContent({
  className,
  children,
  side = 'right',
  variant = 'default',
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: 'top' | 'right' | 'bottom' | 'left'
  variant?: 'default' | 'pane'
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-popover bg-clip-padding text-sm text-popover-foreground shadow-lg transition-[translate,opacity] duration-300 ease-drawer data-ending-style:opacity-0 data-ending-style:duration-200 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-full data-[side=bottom]:data-starting-style:translate-y-full data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm',
          side === 'bottom' && BOTTOM_SHEET,
          variant === 'pane' && PANE,
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={<Button variant="ghost" className="absolute top-3 right-3" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-0.5 p-4', className)} {...props} />
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('font-heading text-base font-medium text-foreground', className)}
      {...props}
    />
  )
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetDescription }
