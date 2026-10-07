import { type ReactNode, createContext, memo, use } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AppWindowIcon, CornerDownRightIcon } from 'lucide-react'
import type { Attachment } from '@goblin/contracts'
import type { SharedContext } from '../../lib/app-context.ts'
import { contextPreview } from '../../lib/app-context.ts'
import { blockKind, openFenceAt } from '../../lib/fences.ts'
import { relativeTime, reporterOf } from '../../lib/threads.ts'
import { MessageFiles } from '../attachments.tsx'
import { RichBlock } from './blocks.tsx'
import { useWorkspaceFeed } from '../workspace-feed.tsx'

type PreProps = { readonly node?: ExtraProps['node']; readonly children?: ReactNode }
const BlockContext = createContext<{
  readonly open: number | undefined
  readonly live: boolean
}>({ open: undefined, live: false })

/**
 * A code block, or the figure it describes (```mermaid, ```chart, ```map). `open` is where a fence the
 * streaming reply has not closed yet begins: that block stays code until it is whole.
 */
function Pre({ node, children }: PreProps) {
  const { open, live } = use(BlockContext)
  const plain = <pre>{children}</pre>
  const code = node?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return plain
  const kind = blockKind(code.properties.className)
  const unfinished = open !== undefined && (node?.position?.start.offset ?? 0) >= open
  if (kind === undefined || (unfinished && live)) return plain
  const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
  return <RichBlock kind={kind} source={source} code={plain} />
}

/** Links open in a new tab without a referrer; wide tables scroll sideways instead of widening the conversation. */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
  pre: Pre,
}
const REMARK_PLUGINS = [remarkGfm]

/**
 * Assistant text as GitHub-flavoured Markdown, set by shadcn/typeset. Raw HTML is never rendered. ```mermaid, ```chart
 * and ```map blocks are drawn (ADR 0023). While `live`, an open fence stays code.
 *
 * Memoised on its text, and its renderers are module constants: a streamed batch rebuilds every part of the
 * transcript, and new renderer functions would remount every link and table (a table scrolled sideways would snap
 * back) and re-parse every message, not just the one still being written.
 */
export const MessageText = memo(function MessageText({
  text,
  live = false,
}: {
  readonly text: string
  readonly live?: boolean
}) {
  return (
    <div className="typeset typeset-chat">
      <BlockContext value={{ open: openFenceAt(text), live }}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
          {text}
        </Markdown>
      </BlockContext>
    </div>
  )
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
  const { conversations } = useWorkspaceFeed()
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
  author,
  thread,
  at,
}: {
  readonly text: string
  readonly context?: readonly SharedContext[]
  readonly attachments?: readonly Attachment[]
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
