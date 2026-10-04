import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import type { ReactNode } from 'react'
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
function Root() {
  return (
    <main className="shell">
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
      <Outlet />
    </main>
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
