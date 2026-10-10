import type { QueryClient } from '@tanstack/react-query'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
} from '@tanstack/react-router'
import { type ReactNode, useEffect } from 'react'
import { AppHost } from '../components/apps/host.tsx'
import { AppLayer } from '../components/apps/stage.tsx'
import { LinkConfirmProvider } from '../components/parts/link-confirm.tsx'
import { EphemeralProvider } from '../components/shell/ephemeral-slot.tsx'
import { ShellNavigation } from '../components/shell/navigation.tsx'
import { ShellFrame } from '../components/shell/shell.tsx'
import { WorkspaceFeedProvider } from '../components/workspace-feed.tsx'
import { useBilling } from '../account/hooks.ts'
import { useSession } from '../auth/hooks.ts'
import { startupImages } from '../lib/startup-images.ts'
import { reportCrash } from '../lib/api.ts'
import { reportUncaught } from '../lib/query/crash-report.ts'
import css from '../styles.css?url'

/** Follows the system's light or dark preference, before first paint and when it changes (as the myapps apps do). */
const THEME_SCRIPT = `(function(){try{var m=matchMedia('(prefers-color-scheme: dark)');var a=function(){var r=document.documentElement;r.classList.toggle('dark',m.matches);r.style.colorScheme=m.matches?'dark':'light'};a();m.addEventListener('change',a)}catch(e){}})()`

/** What every route's loaders and `beforeLoad` receive: the router's own QueryClient (`router.tsx`). */
interface RouterContext {
  readonly queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      // Added to the Home Screen it opens as an app: no browser chrome, the page drawn under a translucent status bar
      // (the top bar pads itself with the safe area, and is right at a 0 inset too).
      { name: 'mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-capable', content: 'yes' },
      { name: 'apple-mobile-web-app-title', content: 'goblin' },
      { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' },
      { title: 'goblin' },
    ],
    links: [
      { rel: 'stylesheet', href: css },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
      { rel: 'icon', href: '/icon-192.png', type: 'image/png', sizes: '192x192' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
      // What a Home Screen app shows while it opens: iOS takes only an exact match for its screen.
      ...startupImages().map(({ href, media }) => ({ rel: 'apple-touch-startup-image', href, media })),
    ],
  }),
  component: Root,
  shellComponent: Document,
})
/** Pages that are part of signing in: no app navigation there. */
const AUTH_PAGES = new Set(['/login', '/consent', '/subscribe', '/subscribe/success', '/terms', '/privacy', '/refunds'])

function Root() {
  const router = useRouter()
  // Errors and rejections nothing caught are reported too, on the route showing when they happened.
  useEffect(
    () => reportUncaught(window, reportCrash, () => router.state.matches.at(-1)?.routeId ?? '__root__'),
    [router],
  )
  return (
    <Shell>
      <Outlet />
    </Shell>
  )
}

/**
 * The app around every page: the rail and the sidebar beside the page (`components/shell`), and above it the stages
 * of the live Apps, which outlive moving between a channel and an App's page, once someone is (or may be) signed in. Signing in, and a visitor who is signed out, get the bare page. While the session is still being
 * checked the shell already shows, so a signed-in owner's first paint does not jump.
 */
function Shell({ children }: { readonly children: ReactNode }) {
  const { state } = useSession()
  const billing = useBilling()
  const path = useRouterState({ select: (router) => router.location.pathname })
  if (state === 'signed-out' || AUTH_PAGES.has(path)) return <main className="shell">{children}</main>
  const enabled = state === 'signed-in' && billing.state?.active === true
  return (
    <WorkspaceFeedProvider enabled={enabled}>
      <ShellNavigation>
        <AppHost>
          <EphemeralProvider>
            <LinkConfirmProvider>
              <ShellFrame>{children}</ShellFrame>
            </LinkConfirmProvider>
          </EphemeralProvider>
          <AppLayer />
        </AppHost>
      </ShellNavigation>
    </WorkspaceFeedProvider>
  )
}

function Document({ children }: { readonly children: ReactNode }) {
  return (
    // The theme script sets the class and color scheme on <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* The page background of each scheme. Written here because the route head keeps one meta per name. */}
        <meta name="theme-color" content="#fafaf9" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#141619" media="(prefers-color-scheme: dark)" />
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
