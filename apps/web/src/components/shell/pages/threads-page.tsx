import { useState } from 'react'
import type { ConversationView } from '@goblin/contracts'
import { ChevronRightIcon, MessagesSquareIcon } from 'lucide-react'
import { threadList } from '../../../lib/rail.ts'
import { relativeTime, repliesLabel, threadTitle } from '../../../lib/threads.ts'
import { channelOf, topicOfChannel } from '../../../lib/topics.ts'
import { activityState } from '../../../lib/workspace-feed.ts'
import { PageSection } from '../../page-section.tsx'
import { useMinute } from '../../use-now.ts'
import { useWorkspaceFeed } from '../../workspace-feed.tsx'
import { ChatRow, RowContents } from './chat-link.tsx'

/** One thread: its name, its channel, its replies and when the last came; a dot while unread, a pulse while it works. */
function ThreadRow({ view, now }: { readonly view: ConversationView; readonly now: number }) {
  const feed = useWorkspaceFeed()
  const channel = topicOfChannel(channelOf(view.id, feed.conversations, feed.topics), feed.topics)
  const working = activityState(feed, view.id) !== 'idle'
  const unread = view.lastReplyAt !== undefined && view.lastReplyAt > (view.readAt ?? 0)
  const when = view.lastReplyAt === undefined ? '' : ` · ${relativeTime(view.lastReplyAt, now)}`
  return (
    <li>
      <ChatRow chat={view.id} unread={unread}>
        <RowContents
          mark={<MessagesSquareIcon aria-hidden />}
          title={threadTitle(view)}
          meta={`#${channel?.name ?? 'Personal'} · ${repliesLabel(view.replies)}${when}`}
          end={
            working ? (
              <span className="thread-busy" aria-label="Working" />
            ) : (
              unread && <span className="unread-dot" aria-label="Unread replies" />
            )
          }
        />
      </ChatRow>
    </li>
  )
}

/** The closed threads, folded under one line until asked for. */
function Closed({ views, now }: { readonly views: readonly ConversationView[]; readonly now: number }) {
  const [open, setOpen] = useState(false)
  if (views.length === 0) return null
  return (
    <section className="page-section">
      <button type="button" className="list-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRightIcon aria-hidden />
        Closed ({views.length})
      </button>
      {open && (
        <ul className="list-rows">
          {views.map((view) => (
            <ThreadRow key={view.id} view={view} now={now} />
          ))}
        </ul>
      )}
    </section>
  )
}

/** `/threads`: every thread of every Topic, unread first, then the rest newest first; the closed folded at the end. */
export function ThreadsPage() {
  const feed = useWorkspaceFeed()
  const now = useMinute()
  const { unread, read, closed } = threadList(feed.conversations)
  if (unread.length + read.length + closed.length === 0) return <p className="page-empty">No threads yet.</p>
  return (
    <div className="page-stack">
      {unread.length > 0 && (
        <PageSection id="unread" title="Unread" count={unread.length}>
          <ul className="list-rows">
            {unread.map((view) => (
              <ThreadRow key={view.id} view={view} now={now} />
            ))}
          </ul>
        </PageSection>
      )}
      {read.length > 0 && unread.length > 0 && (
        <PageSection id="threads" title="Read">
          <ul className="list-rows">
            {read.map((view) => (
              <ThreadRow key={view.id} view={view} now={now} />
            ))}
          </ul>
        </PageSection>
      )}
      {read.length > 0 && unread.length === 0 && (
        <ul className="list-rows">
          {read.map((view) => (
            <ThreadRow key={view.id} view={view} now={now} />
          ))}
        </ul>
      )}
      <Closed views={closed} now={now} />
    </div>
  )
}
