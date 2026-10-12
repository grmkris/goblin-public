// An App as a page of its own (ADRs 0020, 0053): the main column under a bar with the way back to the conversation it
// belongs to and Close, its stage filling the rest, and goblin's composer for that conversation floating over its
// bottom edge, as ChatGPT keeps its composer under an App full screen. A reply that lands shows as one line above the
// composer; a tap on it opens the conversation beside the App, or in a sheet over it on a phone. That is also what an
// App asking for fullscreen gets.
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import type { AppView, ConversationView } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PresenceOrb,
  TopBar,
  TopBarTitle,
} from '@goblin/ui'
import { ChevronLeftIcon, EllipsisIcon, PanelLeftCloseIcon, XIcon } from 'lucide-react'
import { latestReply } from '../../lib/app-chat.ts'
import { appNames, appOrigin } from '../../lib/app-names.ts'
import { appPin } from '../../lib/pins.ts'
import { closedBy, threadTitle } from '../../lib/threads.ts'
import { channelOf, isChannel, topicOfChannel } from '../../lib/topics.ts'
import {
  useApps,
  useConversation as useFeedConversation,
  useConversations,
  useTopics,
} from '../../lib/workspace/hooks.ts'
import { closeWorkspaceAppMutation, updateWorkspaceConversationMutation } from '../../lib/workspace/mutations.ts'
import { ConversationDock } from '../conversation-dock.tsx'
import { useKeyboardInset } from '../use-keyboard.ts'
import { useConversation, useDockInsets, useTranscript } from '../use-conversation.ts'
import { ChatView } from '../shell/chat-view.tsx'
import { PanelProvider, useOpenChat } from '../shell/panel.tsx'
import { PinMenuItem } from '../shell/pin-toggle.tsx'
import { NavigationButton } from '../shell/shell.tsx'
import { AppTile } from './app-tile.tsx'
import { type Insets, useAppHost } from './host.tsx'
import { useAppPlacement } from './placement.ts'
import { isServerApp } from './residency.ts'
import { AppNote, useSlot } from './slot.tsx'

/** Why the App is not on its page: it could not load, it was unloaded to stay under the cap, or it was closed. */
function PageNote({
  app,
  problem,
  onShow,
}: {
  readonly app: AppView
  readonly problem?: string
  readonly onShow: () => void
}) {
  const closed = app.closedAt !== undefined
  const note = closed
    ? 'is closed'
    : problem === undefined
      ? 'was unloaded to save memory'
      : `could not load: ${problem}`
  return (
    <div className="app-page-note">
      <AppNote app={app} note={note}>
        <Button variant="outline" size="sm" onClick={onShow}>
          {closed ? 'Open again' : problem === undefined ? 'Show' : 'Try again'}
        </Button>
      </AppNote>
    </div>
  )
}

/** The page's menu: pin it to the sidebar, and back in the conversation for an App that has a place there. */
function AppPageMenu({ app, name }: { readonly app: AppView; readonly name: string }) {
  const place = useAppPlacement(app)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="App actions" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <PinMenuItem pin={appPin(app, name)} />
        {!isServerApp(app) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={place.inline}>
              <PanelLeftCloseIcon aria-hidden />
              Back in the conversation
            </DropdownMenuItem>
          </>
        )}
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

const px = (value: string): number => Math.round(Number.parseFloat(value) || 0)

/** The device's safe-area insets in pixels, read through a probe (CSS knows them; script only through layout). */
function safeInsets(host: HTMLElement): Insets {
  const probe = document.createElement('div')
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'
  host.appendChild(probe)
  const style = getComputedStyle(probe)
  const insets = { top: 0, right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) }
  probe.remove()
  return insets
}

/**
 * Tells the App what covers its page: the screen's safe areas at the sides and, while the chat bar shows, the bar and
 * the line above it at the bottom (else the safe area there). The top is cleared by the page's own bar.
 */
function useCoveredEdges(id: string, main: RefObject<HTMLElement | null>, bar: boolean) {
  const { setInsets } = useAppHost()
  const keyboard = useKeyboardInset()
  useLayoutEffect(() => {
    const room = main.current
    if (room === null) return undefined
    const covers = () => [...room.querySelectorAll(':scope > [data-app-cover]')]
    const measure = () => {
      const safe = safeInsets(room)
      const tops = covers().map((cover) => cover.getBoundingClientRect().top)
      const bottom = room.getBoundingClientRect().bottom
      const covered = bar && tops.length > 0 ? Math.round(bottom - Math.min(...tops)) : safe.bottom
      setInsets(id, { ...safe, bottom: Math.max(covered, safe.bottom) })
    }
    const sizes = new ResizeObserver(measure)
    // The reply line comes and goes: each time, what covers the room is watched again.
    const watch = () => {
      sizes.disconnect()
      sizes.observe(room)
      for (const cover of covers()) sizes.observe(cover)
      measure()
    }
    const children = new MutationObserver(watch)
    children.observe(room, { childList: true })
    watch()
    return () => {
      children.disconnect()
      sizes.disconnect()
    }
  }, [id, main, bar, keyboard, setInsets])
  useEffect(() => () => setInsets(id, undefined), [id, setInsets])
}

/**
 * The last reply as one line over the composer, from the moment the page first read the conversation: a reply that
 * was there already does not show, and one shows until the owner opens the conversation or sets it aside.
 */
function useReplyLine(parts: Parameters<typeof latestReply>[0], loaded: boolean) {
  const reply = useMemo(() => latestReply(parts), [parts])
  const [baseline, setBaseline] = useState<string | null>()
  const [dismissed, setDismissed] = useState<string>()
  if (loaded && baseline === undefined) setBaseline(reply?.id ?? null)
  const shown = reply !== undefined && baseline !== undefined && reply.id !== baseline && reply.id !== dismissed
  return { reply: shown ? reply : undefined, dismiss: () => setDismissed(reply?.id) }
}

/**
 * goblin's composer for the App's conversation over the page's bottom edge, with what the agent is doing on it, and
 * over it the newest reply as one line that opens the conversation. Both cover the App (`data-app-cover`).
 */
function AppChatBar({
  app,
  view,
  name,
  main,
  onOpen,
}: {
  readonly app: AppView
  readonly view: ConversationView | undefined
  readonly name: string
  readonly main: RefObject<HTMLDivElement | null>
  readonly onOpen: () => void
}) {
  const id = app.conversation
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(main, dock)
  const conversation = useConversation(id)
  const { projection, report } = conversation
  const { parts } = useTranscript(id, projection, report, undefined, conversation.echo)
  const update = useMutation(updateWorkspaceConversationMutation).mutate
  const { reply, dismiss } = useReplyLine(parts, projection !== undefined)
  const open = () => {
    dismiss()
    onOpen()
  }
  return (
    <>
      {reply !== undefined && (
        <div className="app-chat-reply" data-app-cover>
          <button type="button" className="app-chat-reply-open" onClick={open}>
            <PresenceOrb state="idle" label="goblin replied" active={false} />
            <span className="truncate">{reply.line}</span>
          </button>
          <Button variant="ghost" size="icon-sm" aria-label="Hide this reply" onClick={dismiss}>
            <XIcon />
          </Button>
        </div>
      )}
      <ConversationDock
        ref={dock}
        id={id}
        conversation={conversation}
        parts={parts}
        closed={view === undefined ? undefined : closedBy(view)}
        onReopen={() => update({ id, change: { closed: false } })}
        active
        placeholder={`Ask about ${name}…`}
      />
    </>
  )
}

/** The App's conversation beside it (over it on a phone), as its thread panel shows it, with a way to close it. */
function AppConversation({ view, onClose }: { readonly view: ConversationView; readonly onClose: () => void }) {
  const conversations = useConversations()
  const topics = useTopics()
  const channel = channelOf(view.id, conversations, topics)
  const items = useMemo(() => (isChannel(view) ? [] : [{ kind: 'thread' as const, id: view.id }]), [view])
  return (
    <aside
      className="app-chat-panel"
      aria-label={`Conversation: ${threadTitle(view)}`}
      data-app-overlay
    >
      <PanelProvider channel={channel} items={items}>
        <ChatView
          view={view}
          place="panel"
          active
          header={
            <TopBar floating data-app-cover>
              <TopBarTitle>{threadTitle(view)}</TopBarTitle>
              <Button variant="ghost" size="icon" aria-label="Close the conversation" onClick={onClose}>
                <XIcon />
              </Button>
            </TopBar>
          }
        />
      </PanelProvider>
    </aside>
  )
}

/** The page's bar: on a phone the navigation, then the way back to the App's conversation, its name, menu and Close. */
function AppPageBar({
  id,
  app,
  title,
}: {
  readonly id: string
  readonly app: AppView | undefined
  readonly title: string
}) {
  const host = useAppHost()
  return (
    <TopBar data-app-cover>
      <NavigationButton />
      <BackToChannel app={app} />
      <TopBarTitle>
        <span className="app-page-title">
          {app !== undefined && <AppTile origin={appOrigin(app)} />}
          <span className="truncate">{title}</span>
        </span>
      </TopBarTitle>
      {app !== undefined && <AppPageMenu app={app} name={title} />}
      {app !== undefined && app.closedAt === undefined && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close the app"
          title="Close the app"
          onClick={() => host.close(id)}
        >
          <XIcon />
        </Button>
      )}
    </TopBar>
  )
}

/**
 * Loads the App when its page opens, or when the page asks for another panel (`focus`), and offers to show it again
 * when it is unloaded, could not load or was closed (a closed one is opened again first).
 */
function usePageApp(id: string, app: AppView | undefined, focus: string | undefined) {
  const host = useAppHost()
  const reopen = useMutation(closeWorkspaceAppMutation).mutate
  const { show } = host
  const opened = useRef<string | undefined>(undefined)
  const wanted = `${app?.id ?? ''}:${focus ?? ''}`
  useEffect(() => {
    if (opened.current === wanted || app === undefined || app.closedAt !== undefined) return
    opened.current = wanted
    show(app, focus)
  }, [app, focus, wanted, show])
  const problem = host.problems.get(id)
  const unloaded = !host.instances.has(id) && (host.dormant.has(id) || problem !== undefined)
  const showAgain = () => {
    if (app === undefined) return
    if (app.closedAt === undefined) show(app, focus)
    else reopen({ id: app.id, closed: false }, { onSuccess: (reopened) => show(reopened, focus) })
  }
  return { problem, asleep: app?.closedAt !== undefined || unloaded, showAgain }
}

/**
 * `/a/<id>`: the App's bar (the way back to its conversation, its name, its menu and Close), the room its stage
 * fills, and goblin's composer for its conversation over the room's bottom edge. Opening the page loads the App (a
 * server's own App on its `focus` panel); one unloaded later waits behind a note rather than loading again on its own.
 */
export function AppPage({ id, focus }: { readonly id: string; readonly focus?: string }) {
  const apps = useApps()
  const app = apps.find((candidate) => candidate.id === id)
  const view = useFeedConversation(app?.conversation)
  const register = useSlot(`app-page:${id}`)
  const main = useRef<HTMLDivElement>(null)
  const [chatOpen, setChatOpen] = useState(false)
  const { problem, asleep, showAgain } = usePageApp(id, app, focus)
  const title = appNames(apps).get(id) ?? 'App'
  const talking = chatOpen && view !== undefined
  const bar = app !== undefined && !talking
  useCoveredEdges(id, main, bar)
  return (
    <section className="app-page" aria-label={title} data-app-scope>
      <AppPageBar id={id} app={app} title={title} />
      <div className="app-page-body">
        <div ref={main} className="app-page-main">
          {asleep && app !== undefined ? (
            <PageNote app={app} {...(problem === undefined ? {} : { problem })} onShow={showAgain} />
          ) : (
            <div ref={register} className="app-page-slot" />
          )}
          {bar && <AppChatBar app={app} view={view} name={title} main={main} onOpen={() => setChatOpen(true)} />}
        </div>
        {talking && <AppConversation view={view} onClose={() => setChatOpen(false)} />}
      </div>
    </section>
  )
}
