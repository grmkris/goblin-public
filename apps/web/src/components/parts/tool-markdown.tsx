import type { ReactNode } from 'react'
import Markdown, { type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ImageIcon } from 'lucide-react'

/** Only absolute web and mail links keep a destination; every other URL, and every image source, is dropped. */
const webOnly: UrlTransform = (url, key) => (key === 'href' && /^(?:https?|mailto):/iu.test(url) ? url : undefined)

/** A link that says where it leads: untrusted text can name one place and point at another. */
function Link({ href, children }: { readonly href?: string | undefined; readonly children?: ReactNode }) {
  if (href === undefined) return <span>{children}</span>
  const host = URL.parse(href)?.host ?? ''
  const named = host === '' || (typeof children === 'string' && children.includes(host))
  return (
    <>
      <a href={href} title={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
      {!named && <span className="text-muted-foreground"> ({host})</span>}
    </>
  )
}

/** An image is named, never fetched. */
function Picture({ alt }: { readonly alt?: string | undefined }) {
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <ImageIcon aria-hidden className="size-3.5" />
      {alt === undefined || alt === '' ? 'Image' : alt}
    </span>
  )
}

const COMPONENTS: Components = {
  a: Link,
  img: Picture,
  table: ({ children }) => (
    <div className="typeset-scroll">
      <table>{children}</table>
    </div>
  ),
}
const PLUGINS = [remarkGfm]

/**
 * A tool's Markdown output, formatted as untrusted text: nothing loads, only absolute web and mail links work and they
 * show their host, raw HTML stays visible as written, and code fences stay code (no diagram, chart or map is drawn).
 */
export function ToolMarkdown({ text }: { readonly text: string }) {
  return (
    <div className="typeset typeset-tool">
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS} urlTransform={webOnly}>
        {text}
      </Markdown>
    </div>
  )
}
