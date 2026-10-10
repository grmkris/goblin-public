// An App as a page of its own (ADR 0020): the main column under a bar with the way back to the chat it belongs to, its
// stage filling the rest. That is also what an App asking for fullscreen gets.
import { useEffect, useRef } from 'react'
import type { AppView } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TopBar,
  TopBarTitle,
} from '@goblin/ui'
import { ChevronLeftIcon, EllipsisIcon, PanelLeftCloseIcon, XIcon } from 'lucide-react'
import { appNames, appOrigin } from '../../lib/app-names.ts'
import { channelOf, topicOfChannel } from '../../lib/topics.ts'
import { NavigationButton } from '../shell/shell.tsx'
import { useOpenChat } from '../shell/panel.tsx'
import { useApps, useConversations, useTopics } from '../../lib/workspace/hooks.ts'
import { AppTile } from './app-tile.tsx'
import { useAppHost } from './host.tsx'
import { useAppPlacement } from './placement.ts'
import { AppNote, useSlot } from './slot.tsx'

/** Why the App is not on its page: it could not load, or it was unloaded to stay under the cap; and the way back. */
function PageNote({
  app,
  problem,
  onShow,
}: {
  readonly app: AppView
  readonly problem?: string
  readonly onShow: () => void
}) {
  return (
    <div className="app-page-note">
      <AppNote app={app} note={problem === undefined ? 'was unloaded to save memory' : `could not load: ${problem}`}>
        <Button variant="outline" size="sm" onClick={onShow}>
          {problem === undefined ? 'Show' : 'Try again'}
        </Button>
      </AppNote>
    </div>
  )
}

/** The page's menu: back in the conversation, and close the App. */
function AppPageMenu({ app }: { readonly app: AppView }) {
  const host = useAppHost()
  const place = useAppPlacement(app)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="App actions" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={place.inline}>
          <PanelLeftCloseIcon aria-hidden />
          Back in the conversation
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => host.close(app.id)}>
          <XIcon aria-hidden />
          Close the app
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Back to #channel": the way to the chat the App belongs to, named by its channel. */
function BackToChannel({ app }: { readonly app: AppView | undefined }) {
  const conversations = useConversations()
  const topics = useTopics()
  const openChat = useOpenChat()
  const chat = app?.conversation ?? '1'
  const topic = topicOfChannel(channelOf(chat, conversations, topics), topics)
  return (
    <Button variant="ghost" size="sm" onClick={() => openChat(chat)}>
      <ChevronLeftIcon data-icon="inline-start" />
      <span className="truncate">Back to #{topic?.name ?? 'Personal'}</span>
    </Button>
  )
}

/**
 * `/a/<id>`: the App's bar (the way back to its channel, its name, its menu) and the room its stage fills. Opening the
 * page loads the App; one unloaded later waits behind a note rather than loading again on its own.
 */
export function AppPage({ id }: { readonly id: string }) {
  const host = useAppHost()
  const apps = useApps()
  const app = apps.find((candidate) => candidate.id === id)
  const register = useSlot(`app-page:${id}`)
  const problem = host.problems.get(id)
  const asleep = !host.instances.has(id) && (host.dormant.has(id) || problem !== undefined)
  const { show } = host
  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || app === undefined || app.closedAt !== undefined) return
    opened.current = true
    show(app)
  }, [app, show])
  const title = appNames(apps).get(id) ?? 'App'
  return (
    <section className="app-page" aria-label={title}>
      <TopBar data-app-cover>
        <NavigationButton />
        <BackToChannel app={app} />
        <TopBarTitle>
          <span className="app-page-title">
            {app !== undefined && <AppTile origin={appOrigin(app)} />}
            <span className="truncate">{title}</span>
          </span>
        </TopBarTitle>
        {app !== undefined && <AppPageMenu app={app} />}
      </TopBar>
      {asleep && app !== undefined ? (
        <PageNote app={app} {...(problem === undefined ? {} : { problem })} onShow={() => show(app)} />
      ) : (
        <div ref={register} className="app-page-slot" />
      )}
    </section>
  )
}
