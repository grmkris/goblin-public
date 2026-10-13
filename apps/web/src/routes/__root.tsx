import type { QueryClient } from '@tanstack/react-query'
import {
  HeadContent,
  Navigate,
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
import { StartSplash } from '../components/start/splash.tsx'
import { WorkspaceFeedProvider } from '../components/workspace-feed.tsx'
import { useBilling } from '../account/hooks.ts'
import { useSession } from '../auth/hooks.ts'
import { useStartDecision } from '../onboarding/hooks.ts'
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

/** Where the shown page stands: first-run Start's own, or one that waits for Start (`staticData.startRequired`). */
type Place = 'start' | 'gated' | 'other'

/**
 * The app around every page: the rail and the sidebar beside the page (`components/shell`), and above it the stages
 * of the live Apps, which outlive moving between a channel and an App's page, once someone is (or may be) signed in.
 * Signing in, and a visitor who is signed out, get the bare page. First-run Start (ADR 0048) fills the screen on its
 * own. A page that waits for Start shows goblin's splash, never the app, until Start's state says where the owner goes,
 * and goes to Start from the splash; any other page shows the shell while the session is still being checked.
 */
function Shell({ children }: { readonly children: ReactNode }) {
  const { state } = useSession()
  const billing = useBilling()
  const path = useRouterState({ select: (router) => router.location.pathname })
  // The shown matches, not the location: while Start loads, the page before it stays what is drawn, so its splash holds.
  const place = useRouterState({
    select: (router): Place =>
      router.matches.some((match) => match.routeId.startsWith('/start'))
        ? 'start'
        : router.matches.some((match) => match.staticData.startRequired === true)
          ? 'gated'
          : 'other',
  })
  const start = useStartDecision(place === 'gated')
  // goblin's landing (routes/index.tsx) is a whole page of its own, drawn edge to edge; a signed-in owner never sees it.
  if (path === '/') return <main className="landing-root">{children}</main>
  if (state === 'signed-out' || AUTH_PAGES.has(path)) return <main className="shell">{children}</main>
  if (place === 'start') return <main className="start-root">{children}</main>
  if (start.kind !== 'show')
    return (
      <main className="start-root">
        <StartSplash />
        {start.kind === 'start' && <Navigate to="/start/$step" params={{ step: start.step }} replace />}
      </main>
    )
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

/** The colour at the top of each scheme, which Safari tints its bars with: the page's, or the landing's moss. */
const THEME_COLORS = {
  page: { light: '#fafaf9', dark: '#141619' },
  landing: { light: '#233e27', dark: '#162519' },
} as const

function Document({ children }: { readonly children: ReactNode }) {
  const top =
    THEME_COLORS[useRouterState({ select: (router) => router.location.pathname }) === '/' ? 'landing' : 'page']
  return (
    // The theme script sets the class and color scheme on <html> before React hydrates it.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {/* The top colour of each scheme. Written here because the route head keeps one meta per name. */}
        <meta name="theme-color" content={top.light} media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content={top.dark} media="(prefers-color-scheme: dark)" />
        <HeadContent />
      </head>
      <body className="antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  )
}
