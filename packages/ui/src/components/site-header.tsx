// Adapted from grmkris/myapps packages/ui/src/components/site-header.tsx (b8a2763): the header the apps share.
// The one-line app header the apps share: brand, destinations, actions. Below `md` two or more destinations fold into
// an icon menu, so the header never wraps on a phone; safe-area insets keep it clear of the notch and rounded corners.
import { useRender } from '@base-ui/react/use-render'
import { cva, type VariantProps } from 'class-variance-authority'
import { MenuIcon, type LucideIcon } from 'lucide-react'
import type { ComponentProps, ReactElement, ReactNode } from 'react'
import { cn } from '../lib/cn'
import { Button } from './button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu'

/** One destination: the router link (or `<a>`) to render without children; the header adds the label and classes. */
interface SiteHeaderLink {
  readonly label: string
  readonly icon: LucideIcon
  readonly render: ReactElement
}

const brandVariants = cva(
  'inline-flex min-h-11 min-w-0 shrink-0 items-center gap-2 rounded-md font-semibold whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 [&_svg]:size-5 [&_svg]:shrink-0',
  {
    variants: {
      size: { sm: 'text-sm tracking-tight', default: 'text-base tracking-tight', lg: 'text-lg tracking-tight' },
      typography: { default: '', mono: 'font-mono text-xs font-medium tracking-[0.14em] uppercase' },
    },
    defaultVariants: { size: 'default', typography: 'default' },
  },
)

/** The product mark and name, linking home. `render` is the router link (or `<a>`) without children. */
function SiteHeaderBrand({
  render,
  mark,
  size,
  typography,
  children,
}: {
  readonly render: ReactElement
  readonly mark?: ReactNode
  readonly children: ReactNode
} & VariantProps<typeof brandVariants>) {
  return useRender({
    render,
    props: {
      'data-slot': 'site-header-brand',
      className: cn(brandVariants({ size, typography })),
      children: (
        <>
          {mark}
          <span className="truncate">{children}</span>
        </>
      ),
    },
  })
}

const navVariants = cva('min-w-0 items-center', {
  variants: { variant: { default: 'gap-1', pill: 'gap-1 md:rounded-full md:bg-muted/60 md:p-1' } },
  defaultVariants: { variant: 'default' },
})

const linkVariants = cva(
  'inline-flex shrink-0 items-center rounded-full px-3 whitespace-nowrap text-muted-foreground outline-none transition-[color,background-color,box-shadow] hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:text-foreground pointer-coarse:min-h-11',
  {
    variants: {
      variant: {
        default: 'h-8 hover:bg-muted aria-[current=page]:bg-muted',
        pill: 'h-8 hover:bg-muted aria-[current=page]:bg-muted md:h-7 md:hover:bg-transparent md:aria-[current=page]:bg-background md:aria-[current=page]:shadow-xs',
      },
      typography: { default: 'text-[0.8125rem]', mono: 'font-mono text-xs tracking-[0.14em] uppercase' },
    },
    defaultVariants: { variant: 'default', typography: 'default' },
  },
)

type SiteHeaderVariants = VariantProps<typeof linkVariants>

function SiteHeaderNavLink({ link, variant, typography }: { readonly link: SiteHeaderLink } & SiteHeaderVariants) {
  return useRender({
    render: link.render,
    props: {
      'data-slot': 'site-header-link',
      className: cn(linkVariants({ variant, typography })),
      children: link.label,
    },
  })
}

/** The phone menu: the links with their icons, then the menu-only items. */
function SiteHeaderMenu({
  links,
  items,
  label,
}: {
  readonly links: readonly SiteHeaderLink[]
  readonly items: ReactNode
  readonly label: string
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-lg" aria-label={label} className="md:hidden pointer-coarse:size-11" />
        }
      >
        <MenuIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-56">
        {links.length > 0 ? (
          <DropdownMenuGroup>
            {links.map(({ label: text, icon: Icon, render }) => (
              <DropdownMenuItem
                key={text}
                render={render}
                className="pointer-coarse:min-h-11 aria-[current=page]:font-medium"
              >
                <Icon aria-hidden />
                {text}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ) : null}
        {links.length > 0 && items !== undefined ? <DropdownMenuSeparator /> : null}
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The app header. `links` show inline from `md` up; below it, two or more links (or any `menuItems`) fold into one
 * icon menu at the end of the row, while a single link stays inline (`fold` overrides this). `actions` (theme, account) are always visible.
 * `menuItems` are DropdownMenu items shown only in the phone menu, after the links (for example Sign out).
 * On touch screens every header control gets a 44px target; the row is 56px plus the top safe area. `contentClassName`
 * sets the row's width and desktop height only.
 */
function SiteHeader({
  brand,
  links = [],
  actions,
  menuItems,
  menuLabel = 'Menu',
  navLabel = 'Main navigation',
  variant,
  typography,
  bordered = false,
  fold = links.length > 1 || menuItems !== undefined,
  className,
  contentClassName,
  ...props
}: Omit<ComponentProps<'header'>, 'children'> &
  SiteHeaderVariants & {
    readonly brand: ReactNode
    readonly links?: readonly SiteHeaderLink[]
    readonly actions?: ReactNode
    readonly menuItems?: ReactNode
    readonly menuLabel?: string
    readonly navLabel?: string
    readonly bordered?: boolean
    /** Fold the links into the phone menu; by default when there are two or more, or any `menuItems`. */
    readonly fold?: boolean
    readonly contentClassName?: string
  }) {
  return (
    <header
      data-slot="site-header"
      className={cn(
        'w-full shrink-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]',
        bordered && 'border-b',
        className,
      )}
      {...props}
    >
      <div
        data-slot="site-header-content"
        className={cn(
          'mx-auto flex h-14 w-full min-w-0 items-center gap-2 px-4 md:gap-4 md:px-8',
          'pointer-coarse:[&_[data-slot=button]]:h-11 pointer-coarse:[&_[data-slot=button]]:min-w-11',
          contentClassName,
        )}
      >
        {brand}
        {links.length > 0 ? (
          <nav aria-label={navLabel} className={cn(navVariants({ variant }), fold ? 'hidden md:flex' : 'flex')}>
            {links.map((link) => (
              <SiteHeaderNavLink key={link.label} link={link} variant={variant} typography={typography} />
            ))}
          </nav>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
          {fold && (links.length > 0 || menuItems !== undefined) ? (
            <SiteHeaderMenu links={links} items={menuItems} label={menuLabel} />
          ) : null}
        </div>
      </div>
    </header>
  )
}

export { SiteHeader, SiteHeaderBrand, type SiteHeaderLink }
