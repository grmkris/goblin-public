import { HeadContent, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
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
        <p className="eyebrow">Purrable · durable personal agent</p>
        <h1>Your resident workspace</h1>
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
