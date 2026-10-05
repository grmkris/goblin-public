import { createContext, use } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AppWindowIcon } from 'lucide-react'
import type { AppContext } from '@purrable/contracts'
import { contextPreview } from '../../lib/app-context.ts'

/**
 * Assistant text as GitHub-flavoured Markdown, set by shadcn/typeset. Raw HTML is never rendered; links open in a new
 * tab without a referrer; wide tables scroll sideways instead of widening the conversation.
 */
export function MessageText({ text }: { readonly text: string }) {
  return (
    <div className="typeset typeset-chat">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        }}
      >
        {text}
      </Markdown>
    </div>
  )
}

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

/**
 * A message in the user column: the owner's own, or one labelled with who wrote it (Telegram, an MCP client, a thread
 * sharing a note). What an open App shared with it shows as a quiet note, never as their words.
 */
export function UserText({
  text,
  context = [],
  author,
  thread,
}: {
  readonly text: string
  readonly context?: readonly AppContext[]
  readonly author?: string | undefined
  readonly thread?: string | undefined
}) {
  return (
    <>
      {author !== undefined && <Author author={author} thread={thread} />}
      <article className="bubble bubble-user">
        <p className="message-text">{text}</p>
      </article>
      {context.map((shared) => (
        <p key={shared.serverId} className="shared-context" title={shared.text}>
          <AppWindowIcon aria-hidden />
          Shared from {shared.serverId}: {contextPreview(shared.text)}
        </p>
      ))}
    </>
  )
}

export function AssistantText({ text }: { readonly text: string }) {
  return (
    <article className="bubble bubble-assistant">
      <MessageText text={text} />
    </article>
  )
}
