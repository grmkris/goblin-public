import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
export function UserText({ text }: { readonly text: string }) {
  return (
    <article className="bubble bubble-user">
      <p className="message-text">{text}</p>
    </article>
  )
}

export function AssistantText({ text }: { readonly text: string }) {
  return (
    <article className="bubble bubble-assistant">
      <MessageText text={text} />
    </article>
  )
}
