import { type ReactNode, useMemo } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { type Navigation, NavigationContext } from '../../lib/navigation.ts'
import { channelOf } from '../../lib/topics.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { keepDraft } from './drafts.ts'
import { useOpenChat } from './panel.tsx'

/**
 * The shell's navigation (`lib/navigation.ts`) over the router: an App's page is `/a/<id>` in the main column, and
 * leaving it opens the chat the App belongs to; a draft moved into a new thread opens in its channel's panel.
 */
export function ShellNavigation({ children }: { readonly children: ReactNode }) {
  const navigate = useNavigate()
  const path = useRouterState({ select: (router) => router.location.pathname })
  const feed = useWorkspaceFeed()
  const openChat = useOpenChat()
  const value = useMemo<Navigation>(() => {
    const openApp = (app: string) => void navigate({ to: '/a/$appId', params: { appId: app } })
    return {
      isAppPage: (app) => path === `/a/${app}`,
      openApp,
      closeAppPage: (app) => {
        if (path !== `/a/${app}`) return
        openChat(feed.apps.find((candidate) => candidate.id === app)?.conversation ?? '1')
      },
      focusApp: openApp,
      newThreadWith: (draft, from) => {
        keepDraft(draft)
        const channel = channelOf(from, feed.conversations, feed.topics)
        navigate({ to: '/c/$chatId', params: { chatId: channel }, search: { reply: 'new' } }).catch(reportUnexpected)
      },
    }
  }, [navigate, path, feed.apps, feed.conversations, feed.topics, openChat])
  return <NavigationContext value={value}>{children}</NavigationContext>
}
