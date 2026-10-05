import { type ReactNode, use, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ThreadView } from '@purrable/contracts'
import { ChevronRightIcon, MessageSquarePlusIcon, MessageSquareReplyIcon, MessagesSquareIcon } from 'lucide-react'
import type { Part } from '../lib/parts.ts'
import { entryOfPart, relativeTime, repliesLabel, threadTitle, threadsByFork } from '../lib/threads.ts'
import { OpenThread } from './parts/text-part.tsx'
import { useThreads } from './threads.tsx'

/** Main's threads as its transcript shows them: under the message each branched from, and how to start one. */
export type InlineThreads = {
  readonly at: ReadonlyMap<number, readonly ThreadView[]>
  readonly branchable: ReadonlySet<number>
  /** Opens the thread started from `entry` beside main, or a reply that starts one when it is sent. */
  readonly reply: (entry: number) => void
  readonly open: (thread: string) => void
  /** Now, in seconds, a minute at a time: what "2 minutes ago" is measured against. */
  readonly now: number
}

/** Now in seconds, updated each minute while the page is open. */
export function useMinute(): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

/**
 * Inline threads for main: Reply in thread opens the thread already started from that message beside main, or a reply
 * that starts one when it is sent (`draft`).
 */
export function useInlineThreads(
  branchable: ReadonlySet<number>,
  open: (thread: string) => void,
  draft: (entry: number) => void,
): InlineThreads {
  const { views } = useThreads()
  const at = useMemo(() => threadsByFork(views), [views])
  const now = useMinute()
  const reply = useCallback(
    (entry: number) => {
      const existing = at.get(entry)?.[0]
      if (existing === undefined) draft(entry)
      else open(existing.id)
    },
    [at, open, draft],
  )
  return useMemo(() => ({ at, branchable, reply, open, now }), [at, branchable, reply, open, now])
}

/** What a thread row shows: its reply count, name and last reply, and whether the agent is working in it. */
function ThreadSummary({ view, now }: { readonly view: ThreadView; readonly now: number }) {
  const last = view.lastReplyAt
  return (
    <>
      <span className="thread-row-count">{repliesLabel(view.replies ?? 0)}</span>
      <span className="thread-row-meta">
        {threadTitle(view)}
        {last !== undefined && (
          <>
            {' · '}
            <time dateTime={new Date(last * 1000).toISOString()}>{relativeTime(last, now)}</time>
          </>
        )}
      </span>
      {view.busy && <span className="thread-busy" aria-label="Working" />}
      <ChevronRightIcon aria-hidden className="thread-row-chevron" />
    </>
  )
}

/** A thread under the message it branched from, as Slack shows one. */
function ThreadRow({
  view,
  now,
  onOpen,
}: {
  readonly view: ThreadView
  readonly now: number
  readonly onOpen: () => void
}) {
  return (
    <button type="button" className="thread-row" onClick={onOpen}>
      <MessagesSquareIcon aria-hidden />
      <ThreadSummary view={view} now={now} />
    </button>
  )
}

/** Opens a thread beside main where the transcript can (`OpenThread`), or on its own page. */
function OpenThreadButton({ thread, children }: { readonly thread: string; readonly children: ReactNode }) {
  const open = use(OpenThread)
  if (open === undefined)
    return (
      <Link to="/t/$threadId" params={{ threadId: thread }} className="thread-row">
        {children}
      </Link>
    )
  return (
    <button type="button" className="thread-row" onClick={() => open(thread)}>
      {children}
    </button>
  )
}

/**
 * Where main noted a thread the owner started with "+": a quiet row with the thread as it is now (its current name, its
 * replies), which opens it. Main's model saw only the name it had then.
 */
export function ThreadStartedRow({ thread }: { readonly thread: string }) {
  const { views } = useThreads()
  const now = useMinute()
  const view = views.find((candidate) => candidate.id === thread)
  return (
    <div className="thread-rows">
      <OpenThreadButton thread={thread}>
        <MessageSquarePlusIcon aria-hidden />
        <span className="thread-row-lead">You started a thread</span>
        {view === undefined ? (
          <ChevronRightIcon aria-hidden className="thread-row-chevron" />
        ) : (
          <ThreadSummary view={view} now={now} />
        )}
      </OpenThreadButton>
    </div>
  )
}

/** The entry a settled message of the owner or the agent belongs to: what a thread would branch from. */
function messageEntry(part: Part): number | undefined {
  if (part.kind === 'user' || (part.kind === 'text' && !part.live)) return entryOfPart(part.id)
  return undefined
}

/**
 * Under one message of main: the threads started from it, or, when there are none, Reply in thread (shown on hover
 * where there is one). Rows and the action line up with the message's side.
 */
export function PartThreads({ part, threads }: { readonly part: Part; readonly threads: InlineThreads }) {
  const entry = messageEntry(part)
  if (entry === undefined || !threads.branchable.has(entry)) return null
  const side = part.kind === 'user' ? 'end' : 'start'
  const started = threads.at.get(entry) ?? []
  if (started.length === 0)
    return (
      <button type="button" className="message-action" data-side={side} onClick={() => threads.reply(entry)}>
        <MessageSquareReplyIcon aria-hidden />
        Reply in thread
      </button>
    )
  return (
    <div className="thread-rows" data-side={side}>
      {started.map((view) => (
        <ThreadRow key={view.id} view={view} now={threads.now} onOpen={() => threads.open(view.id)} />
      ))}
    </div>
  )
}
