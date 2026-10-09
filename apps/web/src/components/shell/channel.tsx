import { useEffect, useMemo, useState } from 'react'
import { Navigate } from '@tanstack/react-router'
import type { ConversationView, TopicView } from '@goblin/contracts'
import { TopBar, TopBarTitle } from '@goblin/ui'
import { rememberChannel } from '../../lib/last-channel.ts'
import { type PanelSearch, panelItems } from '../../lib/panel.ts'
import { channelOf, isArchived, isChannel, topicOfChannel } from '../../lib/topics.ts'
import { activityState } from '../../lib/workspace-feed.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { ArchivedBanner, ChannelMenu } from './channel-menu.tsx'
import { ChatView } from './chat-view.tsx'
import { PanelProvider } from './panel.tsx'
import { NavigationButton } from './shell.tsx'
import { ThreadPanel } from './thread-panel.tsx'

/** A channel's bar: on a phone the navigation's button, then `#` and the Topic's name with its menu. */
function ChannelHeader({
  view,
  topic,
  onFailure,
}: {
  readonly view: ConversationView
  readonly topic: TopicView | undefined
  readonly onFailure: (text: string) => void
}) {
  const feed = useWorkspaceFeed()
  const working = activityState(feed, view.id) === 'working'
  return (
    <TopBar floating data-app-cover>
      <NavigationButton />
      <TopBarTitle>
        <ChannelMenu
          topic={topic}
          name={topic?.name ?? view.title ?? 'Personal'}
          working={working}
          onFailure={onFailure}
        />
      </TopBarTitle>
    </TopBar>
  )
}

/** The channel and, when its search opens one, the thread panel beside it (over it on a phone). */
function ChannelLayout({ view, search }: { readonly view: ConversationView; readonly search: PanelSearch }) {
  const feed = useWorkspaceFeed()
  const topic = topicOfChannel(view.id, feed.topics)
  const items = useMemo(() => panelItems(search, view.id, feed.conversations), [search, view.id, feed.conversations])
  const [heads, setHeads] = useState<ReadonlySet<string>>(new Set())
  const [failure, setFailure] = useState('')
  useEffect(() => rememberChannel(view.id), [view.id])
  const open = items.length > 0
  const archived = topic !== undefined && isArchived(topic)
  return (
    <PanelProvider channel={view.id} items={items}>
      <div className="channel-layout" data-panel={open || undefined}>
        <div className="channel-column">
          <ChatView
            key={view.id}
            view={view}
            place="channel"
            active={!open}
            header={<ChannelHeader view={view} topic={topic} onFailure={setFailure} />}
            notices={failure === '' ? [] : [failure]}
            {...(archived && { banner: <ArchivedBanner topic={topic} onFailure={setFailure} /> })}
            onHeads={setHeads}
          />
        </div>
        {open && <ThreadPanel heads={heads} />}
      </div>
    </PanelProvider>
  )
}

/**
 * `/c/<id>`: a Topic's channel, with the thread panel its search names. A thread's or subagent's id opens its channel
 * with the panel showing it, so every old link to a chat still leads there.
 */
export function ChannelPage({ chat, search }: { readonly chat: string; readonly search: PanelSearch }) {
  const feed = useWorkspaceFeed()
  const view = feed.conversations.find((candidate) => candidate.id === chat)
  if (view !== undefined && !isChannel(view)) {
    const channel = channelOf(chat, feed.conversations, feed.topics)
    return <Navigate to="/c/$chatId" params={{ chatId: channel }} search={{ thread: Number(chat) }} replace />
  }
  if (view === undefined)
    return (
      <div className="channel-layout" aria-busy>
        <div className="channel-column">
          <section className="chat-view" data-place="channel">
            <TopBar floating>
              <NavigationButton />
            </TopBar>
          </section>
        </div>
      </div>
    )
  return <ChannelLayout view={view} search={search} />
}
