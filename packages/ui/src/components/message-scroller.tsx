// Adapted from the shadcn base-nova registry item `message-scroller` (shadcn/ui, MIT): the styled parts over the
// headless @shadcn/react primitive, which owns the scroll behaviour (patched with unreleased upstream fixes, see
// patches/shadcn-react/README.md). goblin's changes: lucide's arrow instead of the registry's icon placeholder, and
// plain utilities for the registry's scroll-fade and scrollbar helpers (the floating composer and header provide the
// edge fades here), and layout custom properties a parent sets to inset the content under floating chrome:
// --message-scroller-max-width, -gap, -inset-top, -inset-bottom, -inset-x and -end-offset.
// Items render without the registry's `content-visibility: auto` and 10rem placeholder: rows not yet painted measured
// as the placeholder, so the content and the scrollbar shifted while scrolling up, and a just-sent turn was measured
// at the wrong height and yanked to the end (shadcn-ui/ui#11175). The cost is painting every row: main's memory view
// keeps its snapshot short, but a thread renders everything since its last compaction.
import type * as React from 'react'
import { MessageScroller as MessageScrollerPrimitive, useMessageScroller } from '@shadcn/react/message-scroller'
import { ArrowDownIcon } from 'lucide-react'
import { cn } from '../lib/cn'
import { Button } from './button'

function MessageScrollerProvider(props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({ className, ...props }: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn('group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden', className)}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn(
        'size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain outline-none [scrollbar-gutter:stable] [scrollbar-width:thin] data-pending-scroll:invisible',
        className,
      )}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      className={cn(
        'mx-auto flex h-max min-h-full w-full max-w-[var(--message-scroller-max-width,none)] flex-col gap-[var(--message-scroller-gap,1.5rem)] px-[var(--message-scroller-inset-x,0px)] pt-[var(--message-scroller-inset-top,0px)] pb-[var(--message-scroller-inset-bottom,0px)]',
        className,
      )}
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      className={cn('min-w-0 shrink-0', className)}
      {...props}
    />
  )
}

/** Jumps to the start or end; it fades away, out of the tab order, when there is nowhere to go. */
function MessageScrollerButton({
  direction = 'end',
  className,
  children,
  render,
  variant = 'secondary',
  size = 'icon-sm',
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Button> &
  Pick<React.ComponentProps<typeof Button>, 'variant' | 'size'>) {
  return (
    <MessageScrollerPrimitive.Button
      data-slot="message-scroller-button"
      data-direction={direction}
      data-variant={variant}
      data-size={size}
      direction={direction}
      className={cn(
        'absolute left-1/2 -translate-x-1/2 rounded-full border-border bg-background text-foreground shadow-sm transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-[var(--message-scroller-end-offset,1rem)] data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full data-[direction=start]:[&_svg]:rotate-180',
        className,
      )}
      render={render ?? <Button variant={variant} size={size} />}
      {...props}
    >
      {children ?? (
        <>
          <ArrowDownIcon />
          <span className="sr-only">{direction === 'end' ? 'Scroll to end' : 'Scroll to start'}</span>
        </>
      )}
    </MessageScrollerPrimitive.Button>
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  /** Scroll commands for the transcript around it: `scrollToMessage`, `scrollToStart`, `scrollToEnd`. */
  useMessageScroller,
}
