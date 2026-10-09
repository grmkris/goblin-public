import { type ReactNode, useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import type { AppView, TopicView } from '@goblin/contracts'
import { ChevronRightIcon, HashIcon, LayoutGridIcon } from 'lucide-react'
import { jobTrouble } from '../../lib/app-jobs.ts'
import { agentApps, appOrigin } from '../../lib/app-names.ts'
import { isUnread } from '../../lib/threads.ts'
import { channelOf, channels } from '../../lib/topics.ts'
import { activityState } from '../../lib/workspace-feed.ts'
import { AppTile } from '../apps/app-tile.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

/** The sections the owner folded, remembered in this browser (a convenience: without storage they open on reload). */
function useFolded(section: string): readonly [boolean, () => void] {
  const key = `goblin:sidebar:${section}`
  const [folded, setFolded] = useState(false)
  useEffect(() => {
    try {
      setFolded(localStorage.getItem(key) === 'folded')
    } catch {
      setFolded(false)
    }
  }, [key])
  const toggle = () => {
    setFolded(!folded)
    try {
      localStorage.setItem(key, folded ? 'open' : 'folded')
    } catch {
      /* A device preference only. */
    }
  }
  return [folded, toggle]
}

/** A section of the sidebar: a label that folds it, an action at its end, and its rows. */
function Section({
  id,
  label,
  action,
  children,
}: {
  readonly id: string
  readonly label: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  const [folded, toggle] = useFolded(id)
  return (
    <section className="sidebar-section" aria-label={label}>
      <div className="sidebar-section-head">
        <button type="button" className="sidebar-section-toggle" aria-expanded={!folded} onClick={toggle}>
          <ChevronRightIcon aria-hidden />
          {label}
        </button>
        {action}
      </div>
      {!folded && <ul className="sidebar-rows">{children}</ul>}
    </section>
  )
}

/** The channel the page shows: a channel's own page, or the channel a thread or App there belongs to. */
function useCurrentChannel(): string | undefined {
  const feed = useWorkspaceFeed()
  const path = useRouterState({ select: (router) => router.location.pathname })
  const [, kind, id] = /^\/([ca])\/(\d{1,12})$/u.exec(path) ?? []
  if (id === undefined) return undefined
  const chat = kind === 'a' ? feed.apps.find((app) => app.id === id)?.conversation : id
  return chat === undefined ? undefined : channelOf(chat, feed.conversations, feed.topics)
}

/** A Topic's channel: `#` and its name, bold with a dot while it has replies the owner has not read. */
function ChannelRow({ topic, current }: { readonly topic: TopicView; readonly current: boolean }) {
  const feed = useWorkspaceFeed()
  const view = feed.conversations.find((candidate) => candidate.id === topic.conversation)
  const unread = view !== undefined && isUnread(view)
  const working = activityState(feed, topic.conversation) !== 'idle'
  return (
    <li>
      <Link
        to="/c/$conversationId"
        params={{ conversationId: topic.conversation }}
        className="sidebar-row"
        aria-current={current ? 'page' : undefined}
        data-unread={unread || undefined}
      >
        <HashIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">{topic.name}</span>
        {working && <span className="sidebar-row-busy" aria-label="Working" />}
        {unread && !working && <span className="sidebar-row-unread" aria-label="Unread replies" />}
      </Link>
    </li>
  )
}

/** The archived Topics, folded under one row until asked for. */
function Archived({
  topics,
  current,
}: {
  readonly topics: readonly TopicView[]
  readonly current: string | undefined
}) {
  const [open, setOpen] = useState(false)
  if (topics.length === 0) return null
  return (
    <>
      <li>
        <button type="button" className="sidebar-row sidebar-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRightIcon className="sidebar-row-mark" aria-hidden />
          <span className="sidebar-row-name">Archived ({topics.length})</span>
        </button>
      </li>
      {open &&
        topics.map((topic) => <ChannelRow key={topic.id} topic={topic} current={topic.conversation === current} />)}
    </>
  )
}

/** One agent app: its tile and title, and a dot while one of its schedules needs the owner. */
function AppRow({ app, current }: { readonly app: AppView; readonly current: boolean }) {
  const trouble = app.source.kind === 'agent' && app.source.jobs.some(jobTrouble)
  return (
    <li>
      <Link
        to="/a/$appId"
        params={{ appId: app.id }}
        className="sidebar-row"
        aria-current={current ? 'page' : undefined}
      >
        <AppTile origin={appOrigin(app)} />
        <span className="sidebar-row-name">{app.title}</span>
        {trouble && <span className="sidebar-row-alert" aria-label="Needs you" />}
      </Link>
    </li>
  )
}

/**
 * The sidebar: the Topics as channels (Personal first, the archived folded at the end), then the agent apps. A click
 * on a channel opens it.
 */
export function Sidebar() {
  const feed = useWorkspaceFeed()
  const current = useCurrentChannel()
  const path = useRouterState({ select: (router) => router.location.pathname })
  const { active, archived } = channels(feed.topics)
  const apps = agentApps(feed.apps)
  return (
    <nav className="shell-sidebar" aria-label="Topics and apps">
      <header className="sidebar-head">
        <span className="sidebar-title">goblin</span>
      </header>
      <div className="sidebar-scroll">
        <Section id="topics" label="Topics">
          {active.map((topic) => (
            <ChannelRow key={topic.id} topic={topic} current={topic.conversation === current} />
          ))}
          <Archived topics={archived} current={current} />
        </Section>
        {apps.length > 0 && (
          <Section
            id="apps"
            label="Apps"
            action={
              <Link to="/apps" className="sidebar-section-action" aria-label="All apps" title="All apps">
                <LayoutGridIcon aria-hidden />
              </Link>
            }
          >
            {apps.map((app) => (
              <AppRow key={app.id} app={app} current={path === `/a/${app.id}`} />
            ))}
          </Section>
        )}
        <a className="sidebar-credit" href="https://github.com/DanFessler/trellis" target="_blank" rel="noreferrer">
          Workspace layout powered by Trellis by Dan Fessler
        </a>
      </div>
    </nav>
  )
}
