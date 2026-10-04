import { HeadContent, Link, Outlet, Scripts, createRootRoute, useRouterState } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { SessionProvider, useSession } from '../lib/session.tsx'
import css from '../styles.css?url'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Purrable' },
    ],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: Root,
  shellComponent: Document,
})
/** Pages that are part of signing in: no app navigation there. */
const AUTH_PAGES = new Set(['/login', '/consent', '/reset-password'])

function Root() {
  return (
    <SessionProvider>
      <main className="shell">
        <Header />
        <Outlet />
      </main>
    </SessionProvider>
  )
}

/** The app's navigation, once someone is signed in and not in the middle of signing in. */
function Header() {
  const [state] = useSession()
  const path = useRouterState({ select: (router) => router.location.pathname })
  if (state !== 'signed-in' || AUTH_PAGES.has(path)) return null
  return (
    <header className="workspace-header">
      <p className="brand">Purrable</p>
      <nav className="nav" aria-label="Main">
        <Link to="/" activeProps={{ className: 'nav-active' }} activeOptions={{ exact: true }}>
          Chat
        </Link>
        <Link to="/connections" activeProps={{ className: 'nav-active' }}>
          Connections
        </Link>
        <Link to="/settings" activeProps={{ className: 'nav-active' }}>
          Settings
        </Link>
      </nav>
    </header>
  )
}
function Document({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}
