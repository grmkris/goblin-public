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

/** The owner's words, as they typed them. */
/** The owner's message; what an open App shared with it shows as a quiet note, never as their words. */
export function UserText({ text, context = [] }: { readonly text: string; readonly context?: readonly AppContext[] }) {
  return (
    <>
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
