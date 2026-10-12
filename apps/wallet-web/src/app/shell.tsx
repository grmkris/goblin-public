import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  GoblinMark,
  TopBar,
} from '@goblin/ui'
import { Bot, Check, ChevronDown, Copy, Gauge, History, LogOut, WalletMinimal } from 'lucide-react'
import { type ComponentType, type ReactNode, type SVGProps, useState } from 'react'
import { cn, shortAddress } from '../ui/index.ts'
import { Link, useLocation } from './router.tsx'

interface NavItem {
  readonly to: string
  readonly label: string
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>
}

/** The four tabs. Agents keeps the `/connections` path that goblin and older links open. */
const NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: WalletMinimal },
  { to: '/activity', label: 'Activity', icon: History },
  { to: '/limits', label: 'Limits', icon: Gauge },
  { to: '/connections', label: 'Agents', icon: Bot },
]

const isCurrent = (pathname: string, to: string): boolean => (to === '/' ? pathname === '/' : pathname.startsWith(to))

const current = (pathname: string, to: string) => (isCurrent(pathname, to) ? ({ 'aria-current': 'page' } as const) : {})

/** The owner's address as a quiet pill: the full address, Copy and Sign out live behind it. */
function AccountMenu({ owner, onSignOut }: { readonly owner: string; readonly onSignOut: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(owner)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // expected: a refused clipboard leaves the label as it was; the full address is selectable in the menu
      setCopied(false)
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" aria-label="Your account" />}>
        <span className="tabular-nums">{shortAddress(owner)}</span>
        <ChevronDown data-icon="inline-end" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Your address</DropdownMenuLabel>
          <p className="px-1.5 pb-2 text-xs break-all text-muted-foreground tabular-nums select-text pointer-coarse:px-2.5">
            {owner}
          </p>
          <DropdownMenuItem closeOnClick={false} onClick={() => void copy()}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
            {copied ? 'Copied' : 'Copy address'}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={onSignOut}>
            <LogOut aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The four tabs as a compact segmented control in the top bar, where the screen is wide enough for it. */
function TopTabs({ pathname }: { readonly pathname: string }) {
  return (
    <nav aria-label="Pages" className="hidden items-center gap-0.5 rounded-full bg-muted p-0.5 md:flex">
      {NAV.map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          {...current(pathname, to)}
          className={cn(
            'inline-flex h-7 items-center rounded-full px-3 text-13 font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-ring',
            isCurrent(pathname, to)
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground active:text-foreground pointer-fine:hover:text-foreground',
          )}
        >
          {label}
        </Link>
      ))}
    </nav>
  )
}

/** The four tabs as a bar at the bottom of a phone: thumb reach, 56px targets, clear of the home indicator. */
function BottomTabs({ pathname }: { readonly pathname: string }) {
  return (
    <nav
      aria-label="Pages"
      className="material-chrome fixed inset-x-0 bottom-0 z-(--z-chrome) border-t border-border pb-(--safe-bottom) md:hidden"
    >
      <div className="mx-auto grid max-w-md grid-cols-4">
        {NAV.map(({ to, label, icon: Icon }) => {
          const here = isCurrent(pathname, to)
          return (
            <Link
              key={to}
              to={to}
              {...current(pathname, to)}
              className={cn(
                'flex min-h-14 flex-col items-center justify-center gap-1 text-2xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-ring',
                here ? 'text-foreground' : 'text-muted-foreground active:text-foreground',
              )}
            >
              <Icon aria-hidden className="size-5.5" strokeWidth={here ? 2.25 : 1.75} />
              {label}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}

/**
 * The signed-in frame, one narrow column at every width so the wallet reads like a phone wallet on a desk too: a slim
 * top bar with the mark, the tabs (on a wide screen) and the owner's account, the page, and on a phone the tabs at the
 * bottom.
 */
export function Shell({
  owner,
  wide = false,
  onSignOut,
  children,
}: {
  readonly owner: string
  /** A page that needs a little more room (a long form) widens the column a step; the frame stays the same. */
  readonly wide?: boolean
  readonly onSignOut: () => void
  readonly children: ReactNode
}) {
  const { pathname } = useLocation()
  return (
    <div className="flex min-h-dvh flex-col">
      <TopBar>
        <div className="mx-auto flex w-full max-w-md items-center gap-2 ps-3 pe-1 md:grid md:max-w-lg md:grid-cols-[1fr_auto_1fr]">
          <Link
            to="/"
            className="flex items-center gap-2 justify-self-start rounded-md font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-ring"
          >
            <GoblinMark className="size-5" />
            <span className="text-sm">Wallet</span>
          </Link>
          <TopTabs pathname={pathname} />
          <div className="ms-auto flex min-w-0 items-center justify-self-end">
            <AccountMenu owner={owner} onSignOut={onSignOut} />
          </div>
        </div>
      </TopBar>
      <main
        className={cn(
          'mx-auto w-full flex-1 ps-(--page-gutter-left) pe-(--page-gutter-right) pt-6 pb-28 md:pt-10 md:pb-16',
          wide ? 'max-w-xl' : 'max-w-md',
        )}
      >
        {children}
      </main>
      <BottomTabs pathname={pathname} />
    </div>
  )
}
