import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ConversationView } from '@goblin/contracts'
import { Alert, AlertDescription, PresenceOrb } from '@goblin/ui'
import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  MessageSquareReplyIcon,
  MessagesSquareIcon,
  PanelRightOpenIcon,
  XIcon,
} from 'lucide-react'
import { failureText } from '../lib/boundary.ts'
import { openInteractions } from '../lib/interactions.ts'
import type { Part } from '../lib/parts.ts'
import { presenceOf } from '../lib/presence.ts'
import { entryOfPart, isClosed, relativeTime, repliesLabel, threadTitle, threadsByFork } from '../lib/threads.ts'
import { type ItemKey, conversationKey, isOpen } from '../lib/workspace.ts'
import { activityState } from '../lib/workspace-feed.ts'
import { isUnread } from '../lib/workspace-tree.ts'
import { MessageComposer } from './composer.tsx'
import { SharedContextChips } from './apps/offers.tsx'
import { useSendWithAppContext } from './conversation-dock.tsx'
import { InteractionCards } from './interaction-cards.tsx'
import { useMarkRead, useOnScreen } from './on-screen.ts'
import { AppsIn } from './parts/mcp-tool-part.tsx'
import { PartView } from './parts/registry.tsx'
import { postMessage, useConversation, useTranscript } from './use-conversation.ts'
import { useWorkspace } from './workspace.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/**
 * A conversation's threads as its transcript shows them: under the message each branched from, a chip that unfolds
 * the live thread right there, and Reply in thread on the others, which starts one inline.
 */
export type InlineThreads = {
  readonly parent: string
  /** The pane they are in: Open in pane puts a thread beside it. */
  readonly source: ItemKey
  readonly at: ReadonlyMap<number, readonly ConversationView[]>
  readonly branchable: ReadonlySet<number>
  readonly unfolded: ReadonlySet<string>
  /** The message whose inline reply is being written, if any. */
  readonly drafting: number | undefined
  readonly toggle: (thread: string) => void
  /** Unfolds the thread already started from `entry`, or starts writing a reply that becomes one when it is sent. */
  readonly reply: (entry: number) => void
  readonly started: (thread: string) => void
  readonly cancel: () => void
  /** Opens a thread in a pane beside this one. */
  readonly open: (thread: string) => void
  /** Now, in seconds, a minute at a time: what "2 minutes ago" is measured against. */
  readonly now: number
}

const InlineThreadsContext = createContext<InlineThreads | undefined>(undefined)

/** Now in seconds, updated each minute while the page is open. */
function useMinute(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/** The inline threads of conversation `parent`, shown in the pane `source`. */
export function useInlineThreads(parent: string, source: ItemKey, branchable: ReadonlySet<number>): InlineThreads {
  const { conversations } = useWorkspaceFeed()
  const workspace = useWorkspace()
  const at = useMemo(() => threadsByFork(conversations, parent), [conversations, parent])
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set())
  const [drafting, setDrafting] = useState<number>()
  const now = useMinute()
  const toggle = useCallback(
    (thread: string) =>
      setUnfolded((current) => {
        const next = new Set(current)
        if (!next.delete(thread)) next.add(thread)
        return next
      }),
    [],
  )
  const reply = useCallback(
    (entry: number) => {
      const existing = at.get(entry)?.[0]
      if (existing === undefined) setDrafting(entry)
      else setUnfolded((current) => new Set(current).add(existing.id))
    },
    [at],
  )
  const started = useCallback((thread: string) => {
    setDrafting(undefined)
    setUnfolded((current) => new Set(current).add(thread))
  }, [])
  const cancel = useCallback(() => setDrafting(undefined), [])
  const open = useCallback(
    (thread: string) => workspace.open(conversationKey(thread), 'beside', source),
    [workspace, source],
  )
  return useMemo(
    () => ({ parent, source, at, branchable, unfolded, drafting, toggle, reply, started, cancel, open, now }),
    [parent, source, at, branchable, unfolded, drafting, toggle, reply, started, cancel, open, now],
  )
}

/** The inline threads of the transcript around: what a "you started a thread" row unfolds into. */
export function InlineThreadsProvider({
  value,
  children,
}: {
  readonly value: InlineThreads | undefined
  readonly children: ReactNode
}) {
  return <InlineThreadsContext value={value}>{children}</InlineThreadsContext>
}

/** A thread under its message: its reply count, its name, how long ago it last moved, what it is doing. */
function ThreadChip({
  view,
  open,
  now,
  lead,
  onToggle,
}: {
  readonly view: ConversationView
  readonly open: boolean
  readonly now: number
  readonly lead?: string
  readonly onToggle: () => void
}) {
  const feed = useWorkspaceFeed()
  const working = activityState(feed, view.id) !== 'idle'
  return (
    <button type="button" className="thread-row" aria-expanded={open} onClick={onToggle}>
      <MessagesSquareIcon aria-hidden />
      {lead !== undefined && <span className="thread-row-lead">{lead}</span>}
      <span className="thread-row-count">{repliesLabel(view.replies)}</span>
      <span className="thread-row-meta">
        {threadTitle(view)}
        {view.lastReplyAt !== undefined && ` · ${relativeTime(view.lastReplyAt, now)}`}
      </span>
      {working && <span className="thread-busy" aria-label="Working" />}
      {isUnread(view) && !working && <span className="tree-row-unread" aria-label="Unread replies" />}
      <ChevronDownIcon className="thread-row-chevron" aria-hidden />
    </button>
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

/** A thread's small composer: what waits on the owner, then a composer with what its agent is doing. */
function InlineDock({
  id,
  conversation,
  parts,
}: {
  readonly id: string
  readonly conversation: ReturnType<typeof useConversation>
  readonly parts: readonly Part[]
}) {
  const { projection, status, notice, send, stop } = conversation
  const sendOwn = useSendWithAppContext(id, send)
  const running = projection?.running ?? false
  const waiting = useMemo(() => openInteractions(parts), [parts])
  const presence = presenceOf({ status, projection, parts, waiting: waiting.length, exhausted: false })
  return (
    <div className="inline-dock">
      <Notice text={notice} />
      <InteractionCards interactions={waiting} thread={id} onAnswer={send} />
      <SharedContextChips conversation={id} />
      {presence.state !== 'idle' && presence.state !== 'offline' && (
        <span className="inline-dock-presence" aria-live="polite">
          <PresenceOrb state={presence.state} label={presence.label} />
          {presence.label}
        </span>
      )}
      <MessageComposer
        onSend={sendOwn}
        running={running}
        onStop={() => void stop()}
        placeholder="Reply in thread…"
        compact
      />
    </div>
  )
}

/** One settled message of a conversation: the entry a thread would branch from. */
function messageEntry(part: Part): number | undefined {
  if (part.kind === 'user' || (part.kind === 'text' && !part.live)) return entryOfPart(part.id)
  return undefined
}

/**
 * The thread itself, live, under its message: what was said in it (the message it branched from is right above), its
 * own threads, unfolding the same way at any depth, and a small composer. Off screen it stops following for a while.
 */
function InlineThreadBody({ view, threads }: { readonly view: ConversationView; readonly threads: InlineThreads }) {
  const block = useRef<HTMLElement>(null)
  const onScreen = useOnScreen(block)
  const conversation = useConversation(view.id, onScreen)
  const { projection, report } = conversation
  const { parts, branchable } = useTranscript(view.id, projection, report, view.forkEntry)
  const own = useMemo(
    () => (view.forkEntry === undefined ? parts : parts.filter((part) => entryOfPart(part.id) !== view.forkEntry)),
    [parts, view.forkEntry],
  )
  const nested = useInlineThreads(view.id, threads.source, branchable)
  const feed = useWorkspaceFeed()
  const parent = threadTitle(feed.conversations.find((candidate) => candidate.id === view.parent))
  useMarkRead(view, onScreen)
  return (
    <section className="inline-thread" aria-label={threadTitle(view)} ref={block}>
      <header className="inline-thread-header">
        <span className="inline-thread-title">{threadTitle(view)}</span>
        <button type="button" onClick={() => threads.open(view.id)} title="Open in a pane beside">
          <PanelRightOpenIcon aria-hidden />
          Open in pane
        </button>
        <button type="button" onClick={() => threads.toggle(view.id)} aria-label="Fold thread" title="Fold">
          <XIcon aria-hidden />
        </button>
      </header>
      <InlineThreadsProvider value={nested}>
        <AppsIn conversation={view.id}>
          <div className="inline-thread-parts">
            {own.length === 0 && (
              <p className="inline-thread-quiet">An aside. {parent} sees none of it unless you share it.</p>
            )}
            {own.map((part) => (
              <div key={part.id} className="message-item flex flex-col" tabIndex={-1}>
                <PartView part={part} canSwitchModel={false} />
                <MessageThreads part={part} threads={nested} />
              </div>
            ))}
          </div>
        </AppsIn>
      </InlineThreadsProvider>
      {!isClosed(view) && <InlineDock id={view.id} conversation={conversation} parts={parts} />}
    </section>
  )
}

/** A thread under its message: live here, or, while it is in a pane, a note of that with the way to it and back. */
function InlineThread({ view, threads }: { readonly view: ConversationView; readonly threads: InlineThreads }) {
  const workspace = useWorkspace()
  const key = conversationKey(view.id)
  if (isOpen(workspace.state, key))
    return (
      <div className="inline-thread-stub">
        <span>Open in a pane</span>
        <button type="button" onClick={() => workspace.focus(key)}>
          Go to it
        </button>
        <button type="button" onClick={() => workspace.close(key)}>
          Show here
        </button>
      </div>
    )
  return <InlineThreadBody view={view} threads={threads} />
}

const NOTHING_TO_STOP = () => undefined

/** A reply under a message that becomes a thread from it when it is sent; nothing exists until then. */
function InlineDraft({ entry, threads }: { readonly entry: number; readonly threads: InlineThreads }) {
  const { create } = useWorkspaceFeed()
  const [notice, setNotice] = useState('')
  const started = useRef<string | undefined>(undefined)
  async function start(input: string): Promise<boolean> {
    // A retry after a failed send reuses the thread the first attempt started.
    started.current ??= (await create({ conversation: threads.parent, entry }))?.id
    const thread = started.current
    if (thread === undefined) return false
    try {
      await postMessage(thread, input)
    } catch (failure) {
      setNotice(failureText(failure))
      return false
    }
    threads.started(thread)
    return true
  }
  return (
    <section className="inline-thread inline-draft" aria-label="New thread">
      <Notice text={notice} />
      <MessageComposer
        onSend={start}
        running={false}
        onStop={NOTHING_TO_STOP}
        placeholder="Reply in thread…"
        compact
        autoFocus
      />
      <p className="inline-draft-note">
        Sending starts a thread here.
        <button type="button" className="inline-draft-cancel" onClick={threads.cancel}>
          Cancel
        </button>
      </p>
    </section>
  )
}

/** Copies a message's text, and says so for a moment. The clipboard can refuse; then nothing changes. */
function CopyMessage({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="message-action"
      aria-label={copied ? 'Copied' : 'Copy'}
      title={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          () => undefined,
        )
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </button>
  )
}

/**
 * Under one message: the threads started from it, each a chip that unfolds it in place, or, when there are none, its
 * actions (Reply in thread, which starts one here, and Copy), floating on hover where there is one. They line up with
 * the message's side.
 */
export function MessageThreads({ part, threads }: { readonly part: Part; readonly threads: InlineThreads }) {
  const entry = messageEntry(part)
  if (entry === undefined || !threads.branchable.has(entry)) return null
  const side = part.kind === 'user' ? 'end' : 'start'
  const started = threads.at.get(entry) ?? []
  return (
    <div className="thread-rows" data-side={side}>
      {started.length === 0 && threads.drafting !== entry && (
        <span className="message-actions" data-side={side} role="toolbar" aria-label="Message actions">
          <button type="button" className="message-action" onClick={() => threads.reply(entry)}>
            <MessageSquareReplyIcon aria-hidden />
            Reply in thread
          </button>
          {(part.kind === 'user' || part.kind === 'text') && <CopyMessage text={part.text} />}
        </span>
      )}
      {started.map((view) => (
        <ThreadFold key={view.id} view={view} threads={threads} />
      ))}
      {threads.drafting === entry && <InlineDraft entry={entry} threads={threads} />}
    </div>
  )
}

function ThreadFold({
  view,
  threads,
  lead,
}: {
  readonly view: ConversationView
  readonly threads: InlineThreads
  readonly lead?: string
}) {
  const open = threads.unfolded.has(view.id)
  return (
    <>
      <ThreadChip
        view={view}
        open={open}
        now={threads.now}
        onToggle={() => threads.toggle(view.id)}
        {...(lead === undefined ? {} : { lead })}
      />
      {open && <InlineThread view={view} threads={threads} />}
    </>
  )
}

/**
 * Where main noted a thread the owner started with "+": the thread as it is now (its current name, its replies),
 * unfolding in place like any other. Main's model saw only the name it had then.
 */
export function ThreadStartedRow({ thread }: { readonly thread: string }) {
  const feed = useWorkspaceFeed()
  const threads = use(InlineThreadsContext)
  const view = feed.conversations.find((candidate) => candidate.id === thread)
  if (view === undefined || isClosed(view) || threads === undefined)
    return (
      <Link to="/c/$conversationId" params={{ conversationId: thread }} className="thread-row">
        You started a thread
      </Link>
    )
  return (
    <div className="thread-rows" data-side="start">
      <ThreadFold view={view} threads={threads} lead="You started a thread" />
    </div>
  )
}
