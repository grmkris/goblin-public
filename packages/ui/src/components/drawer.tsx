// goblin's drawers, over Base UI's Drawer (a Dialog with gestures): a sheet from the bottom edge, or a panel from the
// left, that follows the finger and is flicked away the way it came. Motion is the theme's drawer curve; while a finger
// drags, the panel tracks it with no transition, and a flick's strength shortens the way out. Under reduced motion the
// kill switch makes every move immediate.
import type * as React from 'react'
import { Drawer as DrawerPrimitive } from '@base-ui/react/drawer'
import { cn } from '../lib/cn'

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
  return <DrawerPrimitive.Root {...props} />
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

/** The dimmed page behind a drawer: it lightens as the drawer is dragged away. */
function DrawerBackdrop() {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-backdrop"
      className="fixed inset-0 z-(--z-overlay) min-h-dvh bg-black/10 opacity-[calc(1-var(--drawer-swipe-progress,0))] transition-opacity duration-300 ease-drawer data-ending-style:opacity-0 data-ending-style:duration-200 data-starting-style:opacity-0 data-swiping:duration-0 supports-backdrop-filter:backdrop-blur-xs supports-[-webkit-touch-callout:none]:absolute"
    />
  )
}

/** The bar a person drags: a visual cue only, the whole sheet takes the gesture. */
function DrawerGrabber() {
  return <div aria-hidden className="mx-auto mt-2 mb-1 h-1 w-10 shrink-0 rounded-full bg-border" />
}

/** What a snapping sheet changes as it moves: where it is, and how much of its end it keeps clear of the screen's edge. */
const SNAPPING =
  'h-[calc(100dvh-6rem)] pb-[calc(var(--drawer-snap-point-offset,0px)+env(safe-area-inset-bottom))] transition-[transform,padding-bottom]'

/**
 * A sheet from the bottom edge: content-sized up to the screen less 6rem, clear of the home indicator, with a grabber.
 * Dragged down it follows the finger; let go far or fast enough it closes, else it settles back. `grabber` replaces the
 * bar (a button that does the same as a drag, say).
 *
 * `snapping` is for a root with `snapPoints`: the sheet is as tall as it goes and rests lower at each smaller point
 * (`--drawer-snap-point-offset`). Its bottom padding grows by the part below the screen, in step with the slide, so
 * what sits at its end (a composer) stays on screen at every point while the rest of it grows and shrinks.
 */
function DrawerContent({
  className,
  children,
  grabber = <DrawerGrabber />,
  snapping = false,
  ...props
}: DrawerPrimitive.Popup.Props & { readonly grabber?: React.ReactNode; readonly snapping?: boolean }) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerBackdrop />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="fixed inset-0 z-(--z-overlay) flex items-end justify-center"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            'relative flex max-h-[calc(100dvh-6rem)] w-full min-h-0 flex-col rounded-t-xl bg-popover pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-sm text-popover-foreground shadow-lg outline-none [transform:translateY(calc(var(--drawer-snap-point-offset,0px)+var(--drawer-swipe-movement-y,0px)))] transition-transform duration-300 ease-drawer data-ending-style:[transform:translateY(100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength,0.7)*300ms)] data-starting-style:[transform:translateY(100%)] data-swiping:duration-0 data-swiping:select-none',
            snapping && SNAPPING,
            className,
          )}
          {...props}
        >
          {grabber}
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  )
}

/**
 * A panel from the left edge (the phone's navigation); give the root `swipeDirection="left"` so a swipe left closes it.
 * `tone="shell"` paints it in the shell's moss, as the rail and sidebar it holds are on a desktop.
 */
function DrawerSide({
  className,
  tone = 'popover',
  ...props
}: DrawerPrimitive.Popup.Props & { readonly tone?: 'popover' | 'shell' }) {
  return (
    <DrawerPrimitive.Portal>
      <DrawerBackdrop />
      <DrawerPrimitive.Viewport
        data-slot="drawer-viewport"
        className="fixed inset-0 z-(--z-overlay) flex items-stretch justify-start"
      >
        <DrawerPrimitive.Popup
          data-slot="drawer-side"
          className={cn(
            tone === 'shell' ? 'bg-(--shell-rail) text-(--shell-foreground)' : 'bg-popover text-popover-foreground',
            'flex h-full flex-col shadow-lg outline-none [transform:translateX(var(--drawer-swipe-movement-x,0px))] transition-transform duration-300 ease-drawer data-ending-style:[transform:translateX(-100%)] data-ending-style:duration-[calc(var(--drawer-swipe-strength,0.7)*300ms)] data-starting-style:[transform:translateX(-100%)] data-swiping:duration-0 data-swiping:select-none',
            className,
          )}
          {...props}
        />
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  )
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="drawer-header" className={cn('flex flex-col gap-0.5 px-4 pt-2 pb-3', className)} {...props} />
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn('font-heading text-base font-medium text-foreground', className)}
      {...props}
    />
  )
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  )
}

export { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerSide, DrawerTitle, DrawerTrigger }
