import { type ReactNode, createContext, use, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Button, Drawer, DrawerDescription, DrawerSide, DrawerTitle, useIsMobile } from '@goblin/ui'
import { PanelLeftIcon } from 'lucide-react'
import { Rail } from './rail.tsx'
import { Sidebar } from './sidebar.tsx'

type Shell = {
  /** Opens the navigation drawer on a phone; on a desktop the rail and sidebar always show. */
  readonly openNavigation: () => void
}

const ShellContext = createContext<Shell>({ openNavigation: () => undefined })

/** The button that opens the navigation on a phone, at the start of a page's or a channel's top bar. */
export function NavigationButton() {
  const { openNavigation } = use(ShellContext)
  return (
    <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation" onClick={openNavigation}>
      <PanelLeftIcon />
    </Button>
  )
}

/** The rail and the sidebar side by side: a column on a desktop, the drawer's contents on a phone. */
function Navigation() {
  return (
    <>
      <Rail />
      <Sidebar />
    </>
  )
}

/**
 * On a phone, the rail and the sidebar in a drawer from the left edge. It closes when the page changes, and on a tap of
 * any link in it, even one to the page already showing; a swipe left closes it the way it came.
 */
function NavigationDrawer({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="left">
      <DrawerSide
        tone="shell"
        className="w-[min(21rem,88vw)]"
        onClickCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('a[href]') !== null) onOpenChange(false)
        }}
      >
        <DrawerTitle className="sr-only">Navigation</DrawerTitle>
        <DrawerDescription className="sr-only">Topics, threads, activity and the app's pages.</DrawerDescription>
        <div className="shell-drawer-body">
          <Navigation />
        </div>
      </DrawerSide>
    </Drawer>
  )
}

/**
 * The signed-in app: a moss rail and sidebar beside the page on a desktop; on a phone the page alone, full width, with
 * the rail and sidebar in a drawer its top bar opens. The server renders the desktop column (CSS hides it on a phone,
 * so a phone's first paint does not show it either).
 */
export function ShellFrame({ children }: { readonly children: ReactNode }) {
  const narrow = useIsMobile()
  const [open, setOpen] = useState(false)
  const path = useRouterState({ select: (router) => router.location.pathname })
  useEffect(() => setOpen(false), [path])
  const openNavigation = useCallback(() => setOpen(true), [])
  const shell = useMemo(() => ({ openNavigation }), [openNavigation])
  return (
    <ShellContext value={shell}>
      <div className="shell-frame">
        {!narrow && (
          <div className="shell-nav" data-slot="shell-nav">
            <Navigation />
          </div>
        )}
        {narrow && <NavigationDrawer open={open} onOpenChange={setOpen} />}
        <div className="shell-main">{children}</div>
      </div>
    </ShellContext>
  )
}
