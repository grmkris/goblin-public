import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useHydrated } from '@tanstack/react-router'
import type { ThreadView } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  PresenceOrb,
  Sheet,
  SheetContent,
  SheetTitle,
  TopBar,
  TopBarTitle,
  useMediaQuery,
} from '@purrable/ui'
import { Maximize2Icon, XIcon } from 'lucide-react'
import { failureText } from '../lib/boundary.ts'
import { openInteractions } from '../lib/interactions.ts'
import type { Part } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { entryOfPart, repliesLabel, rootParts, threadTitle } from '../lib/threads.ts'
import { useApps } from './apps/provider.tsx'
import { MessageComposer } from './composer.tsx'
import { Conversation } from './conversation.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { WithoutApps } from './parts/mcp-tool-part.tsx'
import { PartView } from './parts/registry.tsx'
import { useThreads } from './threads.tsx'
import { postMessage, useConversation, useDockInsets, useTranscript } from './use-conversation.ts'

/** Wide enough for main and the thread side by side (beside an open sidebar); narrower, the thread is a sheet. */
const SIDE_BY_SIDE = '(min-width: 75rem)'

/**
 * The thread panel beside main, as the URL names it: a thread (`thread`), or a reply to one of main's messages that
 * starts a thread when it is sent (`draft`, that message's entry). `open` and `reply` show one; `close` goes back.
 */
export type ThreadPanelControl = {
  readonly thread: string | undefined
  readonly draft: number | undefined
  readonly open: (thread: string) => void
  readonly reply: (entry: number) => void
  readonly close: () => void
}

/** What the panel shows: a thread, or the draft reply that starts one from a message of main. */
type PanelTarget =
  | { readonly kind: 'thread'; readonly thread: string }
  | { readonly kind: 'draft'; readonly entry: number; readonly root: readonly Part[] }

/** The message a thread branched from, then a rule with the count of what was said in the thread since. */
function ThreadRoot({ parts, replies }: { readonly parts: readonly Part[]; readonly replies: number }) {
  return (
    <div className="thread-root">
      {parts.map((part) => (
        <PartView key={part.id} part={part} canSwitchModel={false} />
      ))}
      <p className="thread-rule">{repliesLabel(replies)}</p>
    </div>
  )
}

/** The panel's bar: its name, the full view of a thread that exists, and close. */
function PanelBar({
  title,
  thread,
  onClose,
}: {
  readonly title: string
  readonly thread?: string
  readonly onClose: () => void
}) {
  return (
    <TopBar floating>
      <TopBarTitle>{title}</TopBarTitle>
      {thread !== undefined && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open the thread in full"
          nativeButton={false}
          render={<Link to="/t/$threadId" params={{ threadId: thread }} />}
        >
          <Maximize2Icon />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Close the thread" onClick={onClose}>
        <XIcon />
      </Button>
    </TopBar>
  )
}

function Notice({ text }: { readonly text: string }) {
  if (text === '') return null
  return (
    <Alert>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/** The thread itself: its transcript from the message it branched at, and a composer to reply in it. */
function ThreadBody({ view, onClose }: { readonly view: ThreadView; readonly onClose: () => void }) {
  const { projection, status, notice, report, send, stop } = useConversation(view.id)
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  const { parts } = useTranscript(view.id, projection, report, view.forkEntry ?? 0)
  const running = projection?.running ?? false
  const { refresh } = useThreads()
  // A run starting or ending changes the thread's reply count and busy mark (and a first exchange may name it).
  useEffect(refresh, [refresh, running])
  const fork = view.forkEntry
  const root = fork === undefined ? [] : rootParts(parts, fork)
  const replies = fork === undefined ? parts : parts.filter((part) => entryOfPart(part.id) !== fork)
  const waiting = useMemo(() => openInteractions(parts), [parts])
  const presence = presenceOf({ status, projection, parts, waiting: waiting.length, exhausted: false })
  return (
    <section className="thread-pane chat-pane" aria-label="Thread" ref={pane}>
      <PanelBar title={threadTitle(view)} thread={view.id} onClose={onClose} />
      <WithoutApps>
        <Conversation
          key={view.id}
          parts={replies}
          canSwitchModel={false}
          {...(root.length > 0 && { lead: <ThreadRoot parts={root} replies={view.replies ?? 0} /> })}
        />
      </WithoutApps>
      <div className="chat-dock" ref={dock}>
        <Notice text={notice} />
        <InteractionCards interactions={waiting} onAnswer={send} />
        <MessageComposer
          onSend={(input) => send(input)}
          running={running}
          onStop={() => void stop()}
          placeholder="Reply in thread…"
          context={
            <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <PresenceOrb state={presence.state} label={presence.label} />
              <span className="truncate">{presence.label}</span>
            </span>
          }
        />
      </div>
    </section>
  )
}

const NOTHING_TO_STOP = () => undefined

/**
 * A reply to a message of main before any thread exists: sending it starts the thread from that message and moves the
 * panel to it, so a reply opened and left unsent leaves nothing behind (Pi cannot delete a conversation).
 */
function DraftBody({
  entry,
  root,
  onClose,
  onStarted,
}: {
  readonly entry: number
  readonly root: readonly Part[]
  readonly onClose: () => void
  readonly onStarted: (thread: string) => void
}) {
  const { create } = useThreads()
  const [notice, setNotice] = useState('')
  const started = useRef<string | undefined>(undefined)
  const pane = useRef<HTMLElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  useDockInsets(pane, dock)
  async function start(input: string): Promise<boolean> {
    // A retry after a failed send reuses the thread the first attempt started.
    started.current ??= (await create(entry))?.id
    const thread = started.current
    if (thread === undefined) return false
    try {
      await postMessage(thread, input)
    } catch (failure) {
      setNotice(failureText(failure))
      return false
    }
    onStarted(thread)
    return true
  }
  return (
    <section className="thread-pane chat-pane" aria-label="New thread" ref={pane}>
      <PanelBar title="New thread" onClose={onClose} />
      <Conversation parts={[]} canSwitchModel={false} lead={<ThreadRoot parts={root} replies={0} />} />
      <div className="chat-dock" ref={dock}>
        <Notice text={notice} />
        <MessageComposer
          onSend={start}
          running={false}
          onStop={NOTHING_TO_STOP}
          placeholder="Reply in thread…"
          context={<span className="truncate text-xs text-muted-foreground">Sending starts a thread here</span>}
        />
      </div>
    </section>
  )
}

/**
 * Beside main where there is room, as Slack opens a thread; a sheet from the right edge where there is not. The frame
 * stays put while a draft becomes its thread. Escape closes it.
 */
function PanelFrame({
  title,
  onClose,
  children,
}: {
  readonly title: string
  readonly onClose: () => void
  readonly children: ReactNode
}) {
  const hydrated = useHydrated()
  const sideBySide = useMediaQuery(SIDE_BY_SIDE)
  if (!hydrated) return null
  if (sideBySide)
    return (
      <aside
        className="thread-panel"
        aria-label={title}
        onKeyDown={(event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && onClose()}
      >
        {children}
      </aside>
    )
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" variant="pane" showCloseButton={false}>
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {children}
      </SheetContent>
    </Sheet>
  )
}

function ThreadPanel({
  target,
  onClose,
  onStarted,
}: {
  readonly target: PanelTarget
  readonly onClose: () => void
  readonly onStarted: (thread: string) => void
}) {
  const { views } = useThreads()
  const view = target.kind === 'thread' ? views.find((candidate) => candidate.id === target.thread) : undefined
  const title = target.kind === 'draft' ? 'New thread' : threadTitle(view)
  let body: ReactNode
  if (target.kind === 'draft')
    body = (
      <DraftBody key={target.entry} entry={target.entry} root={target.root} onClose={onClose} onStarted={onStarted} />
    )
  // Until the list has the thread the panel cannot tell where it branched, so it waits rather than show main's history.
  else if (view === undefined)
    body = (
      <section className="thread-pane chat-pane" aria-busy>
        <PanelBar title={title} onClose={onClose} />
      </section>
    )
  else body = <ThreadBody key={view.id} view={view} onClose={onClose} />
  return (
    <PanelFrame title={title} onClose={onClose}>
      {body}
    </PanelFrame>
  )
}

/**
 * The thread panel and a fullscreen App both want the right column: whichever arrived last keeps it, and the other
 * goes (the App back into the transcript, the panel closed).
 */
function useSharedRightColumn(panel: string | undefined, close: () => void): void {
  const { session, setMode } = useApps()
  const fullscreen = session?.mode === 'fullscreen'
  const previous = useRef({ panel, fullscreen })
  useEffect(() => {
    const before = previous.current
    previous.current = { panel, fullscreen }
    if (panel === undefined || !fullscreen) return
    if (before.panel !== panel) setMode('inline')
    else if (!before.fullscreen) close()
  }, [panel, fullscreen, setMode, close])
}

const NO_PANEL = () => undefined

/** The panel beside main, when the URL opens a thread or a reply; `parts` are main's, for a draft's message. */
export function MainThreadPanel({
  panel,
  parts,
}: {
  readonly panel: ThreadPanelControl | undefined
  readonly parts: readonly Part[]
}) {
  let target: PanelTarget | undefined
  if (panel?.thread !== undefined) target = { kind: 'thread', thread: panel.thread }
  else if (panel?.draft !== undefined)
    target = { kind: 'draft', entry: panel.draft, root: rootParts(parts, panel.draft) }
  const key = target?.kind === 'thread' ? target.thread : target && `draft:${target.entry}`
  useSharedRightColumn(key, panel?.close ?? NO_PANEL)
  if (panel === undefined || target === undefined) return null
  return <ThreadPanel target={target} onClose={panel.close} onStarted={panel.open} />
}
