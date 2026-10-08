// Adapted from shadcn/ui's base-nova sidebar (MIT, https://ui.shadcn.com/r/styles/base-nova/sidebar.json): trimmed to
// the one shape goblin uses, a left sidebar that folds to an icon rail on desktop and becomes a drawer on phones.
// The app draws the rail's contents itself; no tooltips, skeletons or inputs; widths are classes rather than inline
// styles; the motion is the sheet curve (`--ease-sheet`) instead of a linear 200ms. The menu parts live in
// sidebar-menu.tsx.
import { PanelLeftIcon } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { useIsMobile } from '../hooks/use-media-query'
import { cn } from '../lib/cn'
import { Button } from './button'
import { Drawer, DrawerDescription, DrawerHeader, DrawerSide, DrawerTitle } from './drawer'

/** The cookie that keeps the desktop sidebar open or closed across reloads; the server reads it for the first paint. */
export const SIDEBAR_COOKIE = 'sidebar_state'
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
const SIDEBAR_SHORTCUT = 'b'

type SidebarContextProps = {
  readonly state: 'expanded' | 'collapsed'
  readonly open: boolean
  readonly setOpen: (open: boolean) => void
  readonly openMobile: boolean
  readonly setOpenMobile: (open: boolean) => void
  readonly isMobile: boolean
  readonly toggleSidebar: () => void
}

const SidebarContext = createContext<SidebarContextProps | null>(null)

function useSidebar(): SidebarContextProps {
  const context = use(SidebarContext)
  if (!context) throw new Error('useSidebar must be used within a SidebarProvider.')
  return context
}

function rememberOpen(open: boolean): void {
  // The server reads this cookie to render the first paint with the sidebar as the owner left it.
  document.cookie = `${SIDEBAR_COOKIE}=${open}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}; samesite=lax`
}

/** ⌘B / Ctrl+B toggles the sidebar, as in the editors and Slack. */
function useToggleShortcut(toggle: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== SIDEBAR_SHORTCUT || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])
}

/**
 * Owns whether the sidebar is open: `defaultOpen` on desktop (remembered in a cookie), and a separate sheet state on
 * phones. Its wrapper sets `--sidebar-width` for the sidebar and anything laid out beside it.
 */
function SidebarProvider({
  defaultOpen = true,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { readonly defaultOpen?: boolean }) {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = useState(false)
  const [open, setOpenState] = useState(defaultOpen)
  const setOpen = useCallback((value: boolean) => {
    setOpenState(value)
    rememberOpen(value)
  }, [])
  const toggleSidebar = useCallback(() => {
    if (isMobile) setOpenMobile((current) => !current)
    else setOpen(!open)
  }, [isMobile, open, setOpen])
  useToggleShortcut(toggleSidebar)
  const value = useMemo<SidebarContextProps>(
    () => ({
      state: open ? 'expanded' : 'collapsed',
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [open, setOpen, isMobile, openMobile, toggleSidebar],
  )
  return (
    <SidebarContext value={value}>
      <div
        data-slot="sidebar-wrapper"
        className={cn(
          'group/sidebar-wrapper flex min-h-svh w-full [--sidebar-width-icon:3.5rem] [--sidebar-width:16rem]',
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </SidebarContext>
  )
}

/**
 * The phone sidebar: a drawer from the left edge that slides fully in, clear of the notch and the home indicator. A
 * swipe left takes it back the way it came; nothing opens it from the edge, so the browser keeps its back gesture.
 */
function SidebarSheet({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  const { openMobile, setOpenMobile } = useSidebar()
  return (
    <Drawer open={openMobile} onOpenChange={setOpenMobile} swipeDirection="left">
      <DrawerSide
        data-slot="sidebar"
        data-mobile="true"
        className="w-(--sidebar-width) max-w-[85vw] bg-sidebar pl-(--safe-left) text-sidebar-foreground [--sidebar-width:18rem]"
      >
        <DrawerHeader className="sr-only">
          <DrawerTitle>{label}</DrawerTitle>
          <DrawerDescription>The conversations and the app's pages.</DrawerDescription>
        </DrawerHeader>
        <div className="flex size-full flex-col">{children}</div>
      </DrawerSide>
    </Drawer>
  )
}

/**
 * The desktop sidebar: a gap that reserves its width in the layout, and the fixed panel beside it. Collapsed, both
 * narrow to the icon rail (`--sidebar-width-icon`); the sidebar is never fully hidden.
 */
function SidebarDesktop({ className, children, ...props }: ComponentProps<'div'>) {
  const { state } = useSidebar()
  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? 'icon' : ''}
      data-side="left"
      data-slot="sidebar"
    >
      <div
        data-slot="sidebar-gap"
        className="relative w-(--sidebar-width) bg-transparent transition-[width] duration-300 ease-(--ease-sheet) group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          'fixed inset-y-0 left-0 z-10 hidden h-svh w-(--sidebar-width) border-r border-sidebar-border transition-[width] duration-300 ease-(--ease-sheet) group-data-[collapsible=icon]:w-(--sidebar-width-icon) md:flex',
          className,
        )}
        {...props}
      >
        <div data-sidebar="sidebar" data-slot="sidebar-inner" className="flex size-full flex-col bg-sidebar">
          {children}
        </div>
      </div>
    </div>
  )
}

/** The app's sidebar: a sheet on phones, a column that slides away on desktop. `label` names it for assistive tech. */
function Sidebar({ label = 'Navigation', ...props }: ComponentProps<'div'> & { readonly label?: string }) {
  const { isMobile } = useSidebar()
  return isMobile ? <SidebarSheet label={label}>{props.children}</SidebarSheet> : <SidebarDesktop {...props} />
}

function SidebarTrigger({ className, onClick, ...props }: ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar()
  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      aria-label="Toggle sidebar"
      className={cn('pointer-coarse:size-11', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeftIcon />
    </Button>
  )
}

/** The sidebar's edge: hover shows a line, a click toggles it, as in Finder. Not in the tab order (the trigger is). */
function SidebarRail({ className, ...props }: ComponentProps<'button'>) {
  const { toggleSidebar } = useSidebar()
  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      aria-label="Toggle sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle sidebar"
      className={cn(
        'absolute inset-y-0 -right-2 z-20 hidden w-4 cursor-w-resize after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 hover:after:bg-sidebar-border sm:flex',
        'group-data-[collapsible=icon]:cursor-e-resize',
        className,
      )}
      {...props}
    />
  )
}

/** The page beside the sidebar. */
function SidebarInset({ className, ...props }: ComponentProps<'main'>) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn('relative flex w-full min-w-0 flex-1 flex-col bg-background', className)}
      {...props}
    />
  )
}

export { Sidebar, SidebarInset, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar }
