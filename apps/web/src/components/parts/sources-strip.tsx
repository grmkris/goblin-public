// What an answer used from other chats (spec §4): a compact strip under it naming the Topics, which opens to each
// source as it was captured (a frozen excerpt, quoted history, never instructions) with the way to its chat.
import { use, useState } from 'react'
import type { RetrievalSource } from '@goblin/contracts'
import { ChevronRightIcon, LibraryIcon } from 'lucide-react'
import { sourceTopics } from '../../lib/sources.ts'
import { OpenThread } from './text-part.tsx'
import { useMinute } from '../use-now.ts'
import { relativeTime } from '../../lib/format.ts'

/**
 * One source: where it is (the Topic, and the thread when it is not the Topic's channel itself), when it was read, the
 * excerpt, and the way to it.
 */
function Source({ source, now }: { readonly source: RetrievalSource; readonly now: number }) {
  const open = use(OpenThread)
  const thread = source.chatTitle === undefined || source.chatTitle === source.topicName ? '' : ` › ${source.chatTitle}`
  const where = `#${source.topicName}${thread}`
  return (
    <li>
      <p className="source-where">
        {open === undefined ? (
          <span>{where}</span>
        ) : (
          <button type="button" className="cause-link" onClick={() => open(source.chat)}>
            {where}
          </button>
        )}
        <span className="source-when">{relativeTime(source.retrievedAt, now)}</span>
      </p>
      <blockquote className="source-excerpt">{source.excerpt}</blockquote>
    </li>
  )
}

/**
 * "Used 3 sources from #Japan trip and #Personal": closed it is one quiet line; open, each source. `searched` says the
 * agent looked them up itself (a `search_chats` call) rather than having them retrieved for it.
 */
export function SourcesStrip({
  sources,
  searched = false,
}: {
  readonly sources: readonly RetrievalSource[]
  readonly searched?: boolean
}) {
  const [open, setOpen] = useState(false)
  const now = useMinute()
  if (sources.length === 0) return null
  const topics = sourceTopics(sources).map((name) => `#${name}`)
  const named = topics.length <= 2 ? topics.join(' and ') : `${topics.slice(0, 2).join(', ')} and more`
  return (
    <div className="sources-strip">
      <button type="button" className="sources-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <LibraryIcon aria-hidden />
        <span className="truncate">
          {searched ? <span className="sources-searched">Searched your chats: </span> : 'Used '}
          {sources.length} {sources.length === 1 ? 'source' : 'sources'} from {named}
        </span>
        <ChevronRightIcon className="sources-chevron" aria-hidden />
      </button>
      {open && (
        <ol className="sources-list">
          {sources.map((source) => (
            <Source key={`${source.chat}:${source.entryStart}`} source={source} now={now} />
          ))}
        </ol>
      )}
    </div>
  )
}
