import { type ReactNode, createContext, memo, use } from 'react'
import { AppWindowIcon, CornerDownRightIcon } from 'lucide-react'
import { type Attachment, type ComposerOption, selectionKey } from '@goblin/contracts'
import type { SharedContext } from '../../lib/app-context.ts'
import { contextPreview } from '../../lib/app-context.ts'
import { relativeTime, reporterOf } from '../../lib/threads.ts'
import { MessageFiles } from '../attachments.tsx'
import { ChatMarkdown } from './markdown.tsx'
import { useConversations } from '../../lib/workspace/hooks.ts'

/**
 * Assistant text as GitHub-flavoured Markdown, set by shadcn/typeset (`ChatMarkdown`), with the little HTML ADR 0039 allows.
 * ```mermaid, ```chart and ```map blocks are drawn (ADR 0023). While `live`, an open fence stays code.
 *
 * Memoised on its text, and its renderers are module constants: a streamed batch rebuilds every part of the
 * transcript, and new renderer functions would remount every link and table (a table scrolled sideways would snap
 * back) and parse every message again, not just the one still being written.
 */
export const MessageText = memo(function MessageText({
  text,
  live = false,
}: {
  readonly text: string
  readonly live?: boolean
}) {
  return <ChatMarkdown text={text} live={live} />
})

/** Opens a thread in a pane beside the transcript: given where a note's thread label can lead somewhere. */
export const OpenThread = createContext<((thread: string) => void) | undefined>(undefined)

/** Who wrote a message; the label of a note shared from a thread opens that thread where it can. */
function Author({ author, thread }: { readonly author: string; readonly thread: string | undefined }) {
  const open = use(OpenThread)
  if (thread === undefined || open === undefined) return <p className="message-author">{author}</p>
  return (
    <button type="button" className="message-author message-author-link" onClick={() => open(thread)}>
      {author}
    </button>
  )
}

/** Why something is in a transcript: a quiet line naming where it came from, then its words, quoted. */
export function Cause({
  icon,
  line,
  text,
}: {
  readonly icon: ReactNode
  readonly line: ReactNode
  readonly text: string
}) {
  return (
    <figure className="cause">
      <figcaption className="cause-line">
        {icon}
        <span>{line}</span>
      </figcaption>
      <blockquote className="cause-quote">
        <MessageText text={text} />
      </blockquote>
    </figure>
  )
}

/** A subagent's report in its spawner's transcript: who reported back and when, then the report. The name opens it. */
function SubagentReport({
  name,
  text,
  at,
}: {
  readonly name: string
  readonly text: string
  readonly at?: number | undefined
}) {
  const conversations = useConversations()
  const open = use(OpenThread)
  const view = conversations.findLast((candidate) => candidate.kind === 'subagent' && candidate.title === name)
  const who =
    view === undefined || open === undefined ? (
      <b>{name}</b>
    ) : (
      <button type="button" className="cause-link" onClick={() => open(view.id)}>
        {name}
      </button>
    )
  const when = at === undefined ? '' : ` · ${relativeTime(Math.floor(at / 1000), Math.floor(Date.now() / 1000))}`
  return (
    <Cause
      icon={<CornerDownRightIcon aria-hidden />}
      line={
        <>
          {who} reported back{when}
        </>
      }
      text={text}
    />
  )
}

/**
 * A message in the user column: the owner's own, or one labelled with who wrote it (Telegram, an MCP client, a thread
 * sharing a note). A subagent's report is not in that column: it reads as the subagent reporting back. The files it
 * carried sit under it; what an open App shared with it shows as a quiet note, never as their words.
 */
export function UserText({
  text,
  context = [],
  attachments = [],
  selections = [],
  author,
  thread,
  at,
}: {
  readonly text: string
  readonly context?: readonly SharedContext[]
  readonly attachments?: readonly Attachment[]
  readonly selections?: readonly ComposerOption[]
  readonly author?: string | undefined
  readonly thread?: string | undefined
  readonly at?: number | undefined
}) {
  const reporter = reporterOf(author)
  if (reporter !== undefined) return <SubagentReport name={reporter} text={text} at={at} />
  return (
    <>
      {author !== undefined && <Author author={author} thread={thread} />}
      <article className="bubble bubble-user">
        {selections.length > 0 && (
          <ul className="flex flex-wrap gap-1 text-xs" aria-label="Selected references">
            {selections.map(({ selection, label }) => (
              <li key={selectionKey(selection)} className="rounded-md bg-muted px-2 py-1">
                {selection.kind === 'skill' ? '/' : '@'}
                {label}
              </li>
            ))}
          </ul>
        )}
        <p className="message-text">{text}</p>
      </article>
      <MessageFiles files={attachments} />
      {context.map((shared) => (
        <p key={shared.from} className="shared-context" title={shared.text}>
          <AppWindowIcon aria-hidden />
          Shared from {shared.from}: {contextPreview(shared.text)}
        </p>
      ))}
    </>
  )
}

export function AssistantText({ text, live = false }: { readonly text: string; readonly live?: boolean }) {
  return (
    <article className="bubble bubble-assistant">
      <MessageText text={text} live={live} />
    </article>
  )
}
