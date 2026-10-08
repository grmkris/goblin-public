// The bar at the top of each page: translucent chrome the content scrolls under, with a soft edge instead of a
// border (Apple's navigation bars). It is 48px plus the top safe area, so it clears the notch in a home-screen app and
// is still right where the inset is 0. On touch screens its buttons get a 44px target.
import type { ComponentProps } from 'react'
import { cn } from '../lib/cn'

/** `floating` lays it over a full-height scroller (a chat); otherwise it sticks to the top of the page as it scrolls. */
function TopBar({ floating = false, className, ...props }: ComponentProps<'header'> & { readonly floating?: boolean }) {
  return (
    <header
      data-slot="top-bar"
      className={cn(
        'material-chrome material-edge-bottom z-(--z-chrome) flex h-(--top-bar-height) w-full shrink-0 items-center gap-1 pt-(--safe-top) pr-[max(0.5rem,var(--safe-right))] pl-[max(0.5rem,var(--safe-left))] select-none',
        'pointer-coarse:[&_[data-slot=button]]:h-11 pointer-coarse:[&_[data-slot=button]]:min-w-11',
        floating ? 'absolute inset-x-0 top-0' : 'sticky top-0',
        className,
      )}
      {...props}
    />
  )
}

/** The page's or the conversation's name; it gives way to the actions beside it. */
function TopBarTitle({ className, ...props }: ComponentProps<'h1'>) {
  return (
    <h1
      data-slot="top-bar-title"
      className={cn('min-w-0 flex-1 truncate px-1 text-sm font-semibold tracking-tight', className)}
      {...props}
    />
  )
}

export { TopBar, TopBarTitle }
