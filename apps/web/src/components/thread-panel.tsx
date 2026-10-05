import { type KeyboardEvent, useEffect, useMemo, useRef } from 'react'
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
import { openInteractions } from '../lib/interactions.ts'
import type { Part } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { entryOfPart, repliesLabel, threadTitle } from '../lib/threads.ts'
import { useApps } from './apps/provider.tsx'
import { MessageComposer } from './composer.tsx'
import { Conversation } from './conversation.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { WithoutApps } from './parts/mcp-tool-part.tsx'
import { PartView } from './parts/registry.tsx'
import { useThreads } from './threads.tsx'
import { useConversation, useDockInsets, useTranscript } from './use-conversation.ts'

/** Wide enough for main and the thread side by side (beside an open sidebar); narrower, the thread is a sheet. */
const SIDE_BY_SIDE = '(min-width: 75rem)'

/** The message the thread branched from, then a rule with the count of what was said in the thread since. */
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
  const atRoot = (part: Part) => view.forkEntry !== undefined && entryOfPart(part.id) === view.forkEntry
  // The root message's words; its thoughts and tool calls stay where they were, in main.
  const root = parts.filter((part) => atRoot(part) && (part.kind === 'text' || part.kind === 'user'))
  const replies = parts.filter((part) => !atRoot(part))
  const waiting = useMemo(() => openInteractions(parts), [parts])
  const presence = presenceOf({ status, projection, parts, waiting: waiting.length, exhausted: false })
  return (
    <section className="thread-pane chat-pane" aria-label="Thread" ref={pane}>
      <TopBar floating>
        <TopBarTitle>{threadTitle(view)}</TopBarTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open the thread in full"
          nativeButton={false}
          render={<Link to="/t/$threadId" params={{ threadId: view.id }} />}
        >
          <Maximize2Icon />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="Close the thread" onClick={onClose}>
          <XIcon />
        </Button>
      </TopBar>
      <WithoutApps>
        <Conversation
          key={view.id}
          parts={replies}
          canSwitchModel={false}
          {...(root.length > 0 && { lead: <ThreadRoot parts={root} replies={view.replies ?? 0} /> })}
        />
      </WithoutApps>
      <div className="chat-dock" ref={dock}>
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
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

/**
 * A thread opened beside main, as Slack opens a thread: a column on the right where there is room, a sheet from the
 * right edge where there is not. Escape closes it.
 */
export function ThreadPanel({ thread, onClose }: { readonly thread: string; readonly onClose: () => void }) {
  const { views } = useThreads()
  const view = views.find((candidate) => candidate.id === thread)
  const hydrated = useHydrated()
  const sideBySide = useMediaQuery(SIDE_BY_SIDE)
  // Until the list arrives the panel cannot tell where the thread branched, so it waits rather than show main's history.
  if (!hydrated || view === undefined) return null
  const body = <ThreadBody key={view.id} view={view} onClose={onClose} />
  if (sideBySide)
    return (
      <aside
        className="thread-panel"
        aria-label={threadTitle(view)}
        onKeyDown={(event: KeyboardEvent) => event.key === 'Escape' && !event.defaultPrevented && onClose()}
      >
        {body}
      </aside>
    )
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" variant="pane" showCloseButton={false}>
        <SheetTitle className="sr-only">{threadTitle(view)}</SheetTitle>
        {body}
      </SheetContent>
    </Sheet>
  )
}

/**
 * The thread panel and a fullscreen App both want the right column: whichever arrived last keeps it, and the other
 * goes (the App back into the transcript, the panel closed).
 */
export function useSharedRightColumn(panel: string | undefined, close: () => void): void {
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
