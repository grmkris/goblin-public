import { useEffect, useMemo, useState } from 'react'
import type { ConversationView } from '@goblin/contracts'
import { CheckIcon, CopyIcon, MessageSquareReplyIcon } from 'lucide-react'
import type { Part } from '../../lib/parts.ts'
import {
  entryOfPart,
  isClosed,
  isUnread,
  relativeTime,
  repliesLabel,
  threadTitle,
  threadsByFork,
} from '../../lib/threads.ts'
import { activityState } from '../../lib/workspace-feed.ts'
import { useMinute } from '../use-now.ts'
import { useWorkspaceFeed } from '../workspace-feed.tsx'
import { DetailsAction } from './message-details.tsx'
import { MoveAction, type Mover } from './move-action.tsx'
import { usePanel } from './panel.tsx'

/**
 * A chat's threads as its transcript shows them: under the message each started from, its summary (replies and the
 * last one's time), which opens it in the panel; on any other message, Reply in thread.
 */
export type ChatThreads = {
  readonly chat: string
  readonly at: ReadonlyMap<number, readonly ConversationView[]>
  readonly branchable: ReadonlySet<number>
  /** Opens the thread already started from `entry`, or a draft reply that becomes one when it is sent. */
  readonly reply: (entry: number) => void
  readonly open: (thread: string) => void
  /** Move to thread, on a channel's newest owner message. */
  readonly mover?: Mover | undefined
}

/** The threads of `chat` for its transcript, opening in the channel's panel. */
export function useChatThreads(chat: string, branchable: ReadonlySet<number>, mover?: Mover): ChatThreads {
  const { conversations } = useWorkspaceFeed()
  const panel = usePanel()
  const at = useMemo(() => threadsByFork(conversations, chat), [conversations, chat])
  return useMemo(
    () => ({
      chat,
      at,
      branchable,
      reply: (entry: number) => {
        const started = at.get(entry)?.[0]
        if (started === undefined) panel.reply(chat, entry)
        else panel.open(started.id)
      },
      open: panel.open,
      mover,
    }),
    [chat, at, branchable, panel, mover],
  )
}

/**
 * A turn moved to the thread and nothing said there since: its summary is the move alone, since the turn's own answer
 * is in the thread but is not a reply, and the head above already shows its words.
 */
const justMoved = (view: ConversationView): boolean => view.movedFrom !== undefined && view.replies === 0

/** What a thread's summary says to a screen reader: its name, its replies (or that it was moved) and its state. */
function summaryLabel(view: ConversationView, working: boolean, unread: boolean): string {
  const said = [`${threadTitle(view)}: ${justMoved(view) ? 'moved to a thread' : repliesLabel(view.replies)}`]
  if (isClosed(view)) said.push('closed')
  if (working) said.push('working')
  else if (unread) said.push('unread replies')
  return said.join(', ')
}

/**
 * A thread under the message it started from, as Slack shows one: "3 replies", then "Last reply 5 minutes ago" (its
 * name in its place until anyone replied), a dot while it has unread replies and a pulse while it works. A click opens it
 * in the panel.
 */
export function ThreadSummary({ view, lead }: { readonly view: ConversationView; readonly lead?: string }) {
  const feed = useWorkspaceFeed()
  const panel = usePanel()
  const now = useMinute()
  const working = activityState(feed, view.id) !== 'idle'
  const unread = isUnread(view)
  const closed = isClosed(view)
  const last = view.lastReplyAt === undefined ? threadTitle(view) : `Last reply ${relativeTime(view.lastReplyAt, now)}`
  return (
    <button
      type="button"
      className="thread-summary"
      data-unread={unread || undefined}
      onClick={() => panel.open(view.id)}
      aria-label={summaryLabel(view, working, unread)}
    >
      {lead !== undefined && <span className="thread-summary-lead">{lead}</span>}
      {justMoved(view) ? (
        <span className="thread-summary-count">View thread</span>
      ) : (
        <>
          <span className="thread-summary-count">{repliesLabel(view.replies)}</span>
          {/* One piece, so on a narrow screen it moves to the second line whole rather than leaving "· closed" alone. */}
          <span className="thread-summary-meta">{closed ? `${last} · closed` : last}</span>
        </>
      )}
      {working && <span className="thread-busy" aria-label="Working" />}
      {unread && !working && <span className="unread-dot" aria-label="Unread replies" />}
      {!justMoved(view) && (
        <span className="thread-summary-open" aria-hidden>
          View thread
        </span>
      )}
    </button>
  )
}

/** One settled message of a chat: the entry a thread would start from. */
function messageEntry(part: Part): number | undefined {
  if (part.kind === 'user' || part.kind === 'persona-ask' || part.kind === 'persona-answer') return entryOfPart(part.id)
  if (part.kind === 'text' && !part.live) return entryOfPart(part.id)
  return undefined
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
 * Under one message: the threads started from it, each a summary that opens it, and the message's actions (Reply in
 * thread, Copy and Details) in a pill that floats over its top edge where a pointer rests, or once a touch focused it.
 */
export function MessageFooter({ part, threads }: { readonly part: Part; readonly threads: ChatThreads }) {
  const entry = messageEntry(part)
  if (entry === undefined || !threads.branchable.has(entry)) return null
  const started = (threads.at.get(entry) ?? []).filter((view) => !isClosed(view) || view.replies > 0)
  const text = 'text' in part ? part.text : ''
  const mover = threads.mover?.entry === entry && started.length === 0 ? threads.mover : undefined
  return (
    <>
      <span className="message-actions" role="toolbar" aria-label="Message actions">
        <button
          type="button"
          className="message-action"
          aria-label="Reply in thread"
          title="Reply in thread"
          onClick={() => threads.reply(entry)}
        >
          <MessageSquareReplyIcon aria-hidden />
        </button>
        {mover !== undefined && <MoveAction mover={mover} />}
        {text !== '' && <CopyMessage text={text} />}
        <DetailsAction chat={threads.chat} entry={entry} />
      </span>
      {mover?.refusal !== undefined && (
        <p className="move-refusal" role="status">
          {mover.refusal}
        </p>
      )}
      {started.length > 0 && (
        <div className="thread-summaries">
          {started.map((view) => (
            <ThreadSummary key={view.id} view={view} />
          ))}
        </div>
      )}
    </>
  )
}

/**
 * Where the channel noted a thread the owner started (`app.thread_started`): the thread as it is now, its summary
 * opening it. The model saw only the name it had then.
 */
export function ThreadStartedRow({ thread }: { readonly thread: string }) {
  const feed = useWorkspaceFeed()
  const view = feed.conversations.find((candidate) => candidate.id === thread)
  if (view === undefined) return null
  return (
    <div className="thread-summaries">
      <ThreadSummary view={view} lead="Started a thread" />
    </div>
  )
}
