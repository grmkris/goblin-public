import { createFileRoute, redirect } from '@tanstack/react-router'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { createServerOnlyFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { Landing } from '../components/landing/landing.tsx'
import { sessionQuery } from '../auth/queries.ts'
import { lastChannel } from '../lib/last-channel.ts'
import { hasSessionCookie, homeFor } from '../lib/home.ts'

const TITLE = 'goblin: your own agent, always on'
const DESCRIPTION =
  "Your own goblin, always on. A personal agent that keeps working while you're away, uses only the tools you allow, and asks before it spends."
const CANONICAL = 'https://goblin.surf/'
const IMAGE = 'https://goblin.surf/og.png'

/** On the server: whether the request carries Better Auth's session cookie. */
const requestHasSession = createServerOnlyFn(() => hasSessionCookie(getCookie))

/**
 * Home. A signed-in owner goes straight to the channel this tab showed last (Personal's at first); a visitor who is
 * signed out gets goblin's landing page. The server decides from the session cookie, before any page is drawn; in the
 * browser, the session as the cache knows it. Neither grants anything: `OwnerGate` still decides on every owner page,
 * so a stale cookie lands on sign-in there.
 */
export const Route = createFileRoute('/')({
  beforeLoad: ({ context }) => {
    const server = typeof window === 'undefined'
    // In the browser this never waits on the network, so the page it hydrates is never held up: the session the cache
    // already knows decides here, and the landing itself leaves for the channel if a check under way says signed in.
    const signedIn = server
      ? requestHasSession()
      : context.queryClient.getQueryData(sessionQuery.queryKey) === 'signed-in'
    // The server cannot know the tab's last channel, so it opens Personal's.
    const home = homeFor(signedIn, server ? PRIMARY_CHAT : lastChannel())
    if (home !== undefined) throw redirect({ to: '/c/$chatId', params: { chatId: home }, statusCode: 307 })
  },
  head: () => ({
    meta: [
      { title: TITLE },
      { name: 'description', content: DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'goblin' },
      { property: 'og:url', content: CANONICAL },
      { property: 'og:title', content: TITLE },
      { property: 'og:description', content: DESCRIPTION },
      { property: 'og:image', content: IMAGE },
      { property: 'og:image:width', content: '1200' },
      { property: 'og:image:height', content: '630' },
      { property: 'og:image:alt', content: 'goblin: your own goblin, always on.' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: TITLE },
      { name: 'twitter:description', content: DESCRIPTION },
      { name: 'twitter:image', content: IMAGE },
    ],
    links: [{ rel: 'canonical', href: CANONICAL }],
  }),
  component: Landing,
})
