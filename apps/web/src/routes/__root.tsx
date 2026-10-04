import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { CatIcon, LogOutIcon, MessageCircleIcon, PlugIcon, SettingsIcon } from 'lucide-react'
import { Button, DropdownMenuGroup, DropdownMenuItem, SiteHeader, SiteHeaderBrand } from '@purrable/ui'
import { SessionProvider, signOut, useSession } from '../lib/session.tsx'
import css from '../styles.css?url'

/** Follows the system's light or dark preference, before first paint and when it changes (as the myapps apps do). */
const THEME_SCRIPT = `(function(){try{var m=matchMedia('(prefers-color-scheme: dark)');var a=function(){var r=document.documentElement;r.classList.toggle('dark',m.matches);r.style.colorScheme=m.matches?'dark':'light'};a();m.addEventListener('change',a)}catch(e){}})()`

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      // The page background of each scheme.
      { name: 'theme-color', content: '#fafaf9', media: '(prefers-color-scheme: light)' },
      { name: 'theme-color', content: '#141619', media: '(prefers-color-scheme: dark)' },
      { title: 'Purrable' },
    ],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Root,
  shellComponent: Document,
})
/** Pages that are part of signing in: no app navigation there. */
const AUTH_PAGES = new Set(['/login', '/consent', '/reset-password'])

const DESTINATIONS = [
  { label: 'Chat', icon: MessageCircleIcon, render: <Link to="/" activeOptions={{ exact: true }} /> },
  { label: 'Connections', icon: PlugIcon, render: <Link to="/connections" /> },
  { label: 'Settings', icon: SettingsIcon, render: <Link to="/settings" /> },
]

function Root() {
  return (
    <SessionProvider>
      <Header />
      <main className="shell">
        <Outlet />
      </main>
    </SessionProvider>
  )
}

/** The shared myapps header, once someone is signed in and not in the middle of signing in. */
function Header() {
  const [state] = useSession()
  const path = useRouterState({ select: (router) => router.location.pathname })
  if (state !== 'signed-in' || AUTH_PAGES.has(path)) return null
  return (
    <SiteHeader
      contentClassName="max-w-[880px]"
      brand={
        <SiteHeaderBrand render={<Link to="/" aria-label="Purrable home" />} mark={<CatIcon aria-hidden />}>
          Purrable
        </SiteHeaderBrand>
      }
      links={DESTINATIONS}
      actions={
        <Button variant="ghost" className="hidden md:inline-flex" onClick={() => void signOut()}>
          <LogOutIcon data-icon="inline-start" />
          Sign out
        </Button>
      }
      menuItems={
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => void signOut()}>
            <LogOutIcon aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuGroup>
      }
    />
  )
}
function Document({ children }: { readonly children: ReactNode }) {
  return (
    // The theme script sets the class and color scheme on <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
