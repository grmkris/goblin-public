import { type ReactNode, use, useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { type ConversationView, MAIN_THREAD } from '@purrable/contracts'
import { ChevronRightIcon, MessageSquareReplyIcon } from 'lucide-react'
import type { Part } from '../lib/parts.ts'
import { entryOfPart, isClosed, threadsByFork } from '../lib/threads.ts'
import { activityState } from '../lib/workspace-feed.ts'
import { OpenThread } from './parts/text-part.tsx'
import { ThreadPreviewBlock } from './thread-preview.tsx'
import { useWorkspaceFeed } from './workspace-feed.tsx'

/** Main's threads as its transcript shows them: under the message each branched from, and how to start one. */
export type InlineThreads = {
  readonly at: ReadonlyMap<number, readonly ConversationView[]>
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
  const { conversations } = useWorkspaceFeed()
  const at = useMemo(() => threadsByFork(conversations, MAIN_THREAD), [conversations])
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
  const feed = useWorkspaceFeed()
  const now = useMinute()
  const view = feed.conversations.find((candidate) => candidate.id === thread)
  const open = use(OpenThread)
  if (view !== undefined && !isClosed(view))
    return (
      <div className="thread-rows" data-side="start">
        <ThreadPreviewBlock
          view={view}
          working={activityState(feed, thread) !== 'idle'}
          now={now}
          started
          onOpen={open === undefined ? undefined : () => open(thread)}
        />
      </div>
    )
  return (
    <OpenThreadButton thread={thread}>
      You started a thread
      <ChevronRightIcon aria-hidden />
    </OpenThreadButton>
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
  const feed = useWorkspaceFeed()
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
        <ThreadPreviewBlock
          key={view.id}
          view={view}
          working={activityState(feed, view.id) !== 'idle'}
          now={threads.now}
          onOpen={() => threads.open(view.id)}
        />
      ))}
    </div>
  )
}
