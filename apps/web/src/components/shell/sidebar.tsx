import { type ReactNode, useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import type { AppView, ConversationView, PersonaView, TopicView } from '@goblin/contracts'
import { ChevronRightIcon, HashIcon, LayoutGridIcon, MessagesSquareIcon, PlusIcon } from 'lucide-react'
import { jobTrouble } from '../../lib/app-jobs.ts'
import { agentApps, appOrigin } from '../../lib/app-names.ts'
import { activePersonas } from '../../lib/personas.ts'
import { isUnread, threadTitle } from '../../lib/threads.ts'
import { channels, topicThreads } from '../../lib/topics.ts'
import {
  useActivities,
  useActivity,
  useApps,
  useConversation,
  useConversations,
  usePersonas,
  useTopics,
} from '../../lib/workspace/hooks.ts'
import { AppTile } from '../apps/app-tile.tsx'
import { PersonaAvatar } from '../persona-avatar.tsx'
import { useCurrent, useFolded, useRecentThreads } from './sidebar-state.ts'
import { TopicDialog } from './topic-dialog.tsx'

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

/** A Topic's channel: `#` and its name, bold with a dot while it has replies the owner has not read. */
function ChannelRow({ topic, current }: { readonly topic: TopicView; readonly current: boolean }) {
  const view = useConversation(topic.conversation)
  const unread = view !== undefined && isUnread(view)
  const working = useActivity(topic.conversation) !== undefined
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
  const unread = isUnread(view)
  const working = useActivity(view.id) !== undefined
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
  const conversations = useConversations()
  const topics = useTopics()
  const activity = useActivities()
  const shown = current.thread === undefined ? recent : new Set([...recent, current.thread])
  const threads = topicThreads(topic.conversation, conversations, topics, activity, shown)
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

/** The Personas, then "+ Add persona". */
function Personas({ path }: { readonly path: string }) {
  const personas = usePersonas()
  return (
    <Section id="personas" label="Personas">
      {activePersonas(personas).map((persona) => (
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

/** "+ Add topic" at the end of the Topics: it opens the new Topic's dialog. */
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
  const current = useCurrent()
  const recent = useRecentThreads()
  const path = useRouterState({ select: (router) => router.location.pathname })
  const { active, archived } = channels(useTopics())
  const apps = useApps(agentApps)
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
          <AddTopic />
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
