import { type ReactNode, useEffect, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import type { AppView, ConversationView, PersonaView, TopicView } from '@goblin/contracts'
import { ChevronRightIcon, HashIcon, LayoutGridIcon, MessagesSquareIcon, PlusIcon } from 'lucide-react'
import { jobTrouble } from '../../lib/app-jobs.ts'
import { agentApps, appOrigin } from '../../lib/app-names.ts'
import { activePersonas } from '../../lib/personas.ts'
import { recentThreads } from '../../lib/recent-threads.ts'
import { isUnread, threadTitle } from '../../lib/threads.ts'
import { channelOf, channels, topicThreads } from '../../lib/topics.ts'
import { activityState } from '../../lib/workspace-feed.ts'
import { AppTile } from '../apps/app-tile.tsx'
import { PersonaAvatar } from '../persona-avatar.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { usePersonasOn } from './personas-on.ts'
import { TopicDialog } from './topic-dialog.tsx'

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

/** Where the page is: the channel it shows (a channel's own page, or the channel of a thread or App there) and its thread. */
function useCurrent(): { readonly channel: string | undefined; readonly thread: string | undefined } {
  const feed = useWorkspaceFeed()
  const location = useRouterState({ select: (router) => router.location })
  const [, kind, id] = /^\/([ca])\/(\d{1,12})$/u.exec(location.pathname) ?? []
  if (id === undefined) return { channel: undefined, thread: undefined }
  const chat = kind === 'a' ? feed.apps.find((app) => app.id === id)?.conversation : id
  const thread = kind === 'c' ? location.search.thread : undefined
  return {
    channel: chat === undefined ? undefined : channelOf(chat, feed.conversations, feed.topics),
    thread: thread === undefined ? undefined : String(thread),
  }
}

/** The threads this browser opened recently, read again as the page changes (a device convenience). */
function useRecentThreads(): ReadonlySet<string> {
  const href = useRouterState({ select: (router) => router.location.href })
  const [recent, setRecent] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setRecent(new Set(recentThreads())), [href])
  return recent
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
        to="/c/$chatId"
        params={{ chatId: topic.conversation }}
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

/** A thread under its channel: its name, bold with a dot while unread, a pulse while it works; it opens in the panel. */
function ThreadRow({
  view,
  channel,
  current,
}: {
  readonly view: ConversationView
  readonly channel: string
  readonly current: boolean
}) {
  const feed = useWorkspaceFeed()
  const unread = isUnread(view)
  const working = activityState(feed, view.id) !== 'idle'
  return (
    <li>
      <Link
        to="/c/$chatId"
        params={{ chatId: channel }}
        search={{ thread: Number(view.id) }}
        className="sidebar-row sidebar-thread"
        aria-current={current ? 'page' : undefined}
        data-unread={unread || undefined}
      >
        <MessagesSquareIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">{threadTitle(view)}</span>
        {working && <span className="sidebar-row-busy" aria-label="Working" />}
        {unread && !working && <span className="sidebar-row-unread" aria-label="Unread replies" />}
      </Link>
    </li>
  )
}

/** A channel with, one flat level under it, its threads at work, unread, recently opened or showing now. */
function ChannelWithThreads({
  topic,
  current,
  recent,
}: {
  readonly topic: TopicView
  readonly current: ReturnType<typeof useCurrent>
  readonly recent: ReadonlySet<string>
}) {
  const feed = useWorkspaceFeed()
  const shown = current.thread === undefined ? recent : new Set([...recent, current.thread])
  const threads = topicThreads(topic.conversation, feed.conversations, feed.topics, feed.activity, shown)
  return (
    <>
      <ChannelRow topic={topic} current={topic.conversation === current.channel && current.thread === undefined} />
      {threads.map((view) => (
        <ThreadRow key={view.id} view={view} channel={topic.conversation} current={view.id === current.thread} />
      ))}
    </>
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

/** A Persona: its mark and `@name`; a click opens its profile (never a chat with it). */
function PersonaRow({ persona, current }: { readonly persona: PersonaView; readonly current: boolean }) {
  return (
    <li>
      <Link
        to="/p/$id"
        params={{ id: String(persona.id) }}
        className="sidebar-row"
        aria-current={current ? 'page' : undefined}
      >
        <PersonaAvatar avatar={persona.avatar} size="sm" />
        <span className="sidebar-row-name">@{persona.name}</span>
      </Link>
    </li>
  )
}

/** The Personas, on a server that has them, then "+ Add persona". */
function Personas({ path }: { readonly path: string }) {
  const feed = useWorkspaceFeed()
  if (!usePersonasOn()) return null
  return (
    <Section id="personas" label="Personas">
      {activePersonas(feed.personas).map((persona) => (
        <PersonaRow key={persona.id} persona={persona} current={path === `/p/${persona.id}`} />
      ))}
      <li>
        <Link
          to="/p/$id"
          params={{ id: 'new' }}
          className="sidebar-row"
          aria-current={path === '/p/new' ? 'page' : undefined}
        >
          <PlusIcon className="sidebar-row-mark" aria-hidden />
          <span className="sidebar-row-name">Add persona</span>
        </Link>
      </li>
    </Section>
  )
}

/** "+ Add topic" at the end of the Topics, on a server that has them: it opens the new Topic's dialog. */
function AddTopic() {
  const [open, setOpen] = useState(false)
  return (
    <li>
      <button type="button" className="sidebar-row" onClick={() => setOpen(true)}>
        <PlusIcon className="sidebar-row-mark" aria-hidden />
        <span className="sidebar-row-name">Add topic</span>
      </button>
      {open && <TopicDialog open onOpenChange={setOpen} />}
    </li>
  )
}

/**
 * The sidebar: the Topics as channels (Personal first, each with its live threads under it, the archived folded at the
 * end, then Add topic), then the Personas (a click opens a profile), then the agent apps. A click on a channel opens it; on a thread, opens it in the panel.
 */
export function Sidebar() {
  const feed = useWorkspaceFeed()
  const current = useCurrent()
  const recent = useRecentThreads()
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
            <ChannelWithThreads key={topic.id} topic={topic} current={current} recent={recent} />
          ))}
          <Archived topics={archived} current={current.channel} />
          {feed.topics !== undefined && <AddTopic />}
        </Section>
        <Personas path={path} />
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
      </div>
    </nav>
  )
}
