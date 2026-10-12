import { Button, GoblinMark, TopBar } from '@goblin/ui'
import { Activity, Home, Link2, LogOut, SlidersHorizontal } from 'lucide-react'
import type { ComponentType, ReactNode, SVGProps } from 'react'
import { AddressChip, cn } from '../ui/index.ts'
import { Link, useLocation } from './router.tsx'

interface NavItem {
  readonly to: string
  readonly label: string
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>
}

const NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: Home },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/limits', label: 'Limits', icon: SlidersHorizontal },
  { to: '/connections', label: 'Connections', icon: Link2 },
]

const isCurrent = (pathname: string, to: string): boolean => (to === '/' ? pathname === '/' : pathname.startsWith(to))

/**
 * The signed-in frame: a top bar with the owner's address and sign out, the four pages as inline links on a wide
 * screen and as a tab bar on a phone (thumb reach, 44px+ targets, clear of the home indicator).
 */
export function Shell({
  owner,
  wide = false,
  onSignOut,
  children,
}: {
  readonly owner: string
  /** A page with columns side by side (setup) takes more width than a reading page. */
  readonly wide?: boolean
  readonly onSignOut: () => void
  readonly children: ReactNode
}) {
  const { pathname } = useLocation()
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar>
        <Link to="/" className="flex items-center gap-2 rounded-md px-1 font-semibold tracking-tight">
          <GoblinMark className="size-5" />
          <span className="text-sm">Wallet</span>
        </Link>
        <nav aria-label="Pages" className="ms-4 hidden items-center gap-1 md:flex">
          {NAV.map(({ to, label }) => {
            const current = isCurrent(pathname, to)
            return (
              <Link
                key={to}
                to={to}
                {...(current ? { 'aria-current': 'page' as const } : {})}
                className={cn(
                  'inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring',
                  current
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground active:text-foreground pointer-fine:hover:text-foreground',
                )}
              >
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="ms-auto flex min-w-0 items-center gap-3">
          <AddressChip address={owner} />
          <Button type="button" variant="ghost" size="icon" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
            <LogOut aria-hidden />
          </Button>
        </div>
      </TopBar>
      <main
        className={cn(
          'mx-auto w-full flex-1 px-(--page-gutter-left) pt-6 pb-28 md:pb-16',
          wide ? 'max-w-5xl' : 'max-w-3xl',
        )}
      >
        {children}
      </main>
      <nav
        aria-label="Pages"
        className="material-chrome fixed inset-x-0 bottom-0 z-(--z-chrome) grid grid-cols-4 border-t border-border pb-(--safe-bottom) md:hidden"
      >
        {NAV.map(({ to, label, icon: Icon }) => {
          const current = isCurrent(pathname, to)
          return (
            <Link
              key={to}
              to={to}
              {...(current ? { 'aria-current': 'page' as const } : {})}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring',
                current ? 'text-foreground' : 'text-muted-foreground active:text-foreground',
              )}
            >
              <Icon aria-hidden className="size-5" strokeWidth={current ? 2.25 : 1.75} />
              {label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
