// The HTML a reply may write, and the addresses its links and images may have (ADR 0039).
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { type Options as Schema } from 'rehype-sanitize'
import type { PluggableList } from 'unified'

/** The elements Markdown itself makes (CommonMark and GFM: tables, task lists, strikethrough, footnotes). */
const MARKDOWN = [
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'img',
  'input',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'strong',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'ul',
]
/** What a reply may add in HTML: a line break (in a table cell), a fold, keys, sub- and superscripts, marks, edits. */
const EXTRA = ['details', 'summary', 'kbd', 'sub', 'mark', 'ins']

/** Ids only as remark-rehype makes them for footnotes, so a reply's own `id` cannot clobber a page global. */
const FOOTNOTE_ID: [string, RegExp] = ['id', /^user-content-/u]

/**
 * What survives of a reply's HTML: the elements above with the few attributes Markdown needs, and nothing else; no
 * styles, classes of its own, event handlers, frames, forms, scripts or media. Ids are not prefixed again (remark-rehype
 * already prefixed the footnotes', and they must keep matching their links).
 */
export const REPLY_SCHEMA: Schema = {
  tagNames: [...MARKDOWN, ...EXTRA],
  attributes: {
    a: ['href', 'title', FOOTNOTE_ID, 'ariaDescribedBy', 'ariaLabel', 'dataFootnoteRef', 'dataFootnoteBackref'],
    img: ['src', 'alt', 'title'],
    // A code block's language, and remark-math's marks on math, which KaTeX then sets.
    code: [['className', /^language-./u, 'math-inline', 'math-display']],
    input: [['type', 'checkbox'], ['disabled', true], 'checked'],
    li: [FOOTNOTE_ID, ['className', 'task-list-item']],
    ul: [['className', 'contains-task-list']],
    ol: ['start', ['className', 'contains-task-list']],
    section: ['dataFootnotes', ['className', 'footnotes']],
    h2: [FOOTNOTE_ID, ['className', 'sr-only']],
    td: ['align'],
    th: ['align'],
    details: ['open'],
  },
  protocols: { href: ['http', 'https', 'mailto'], src: ['http', 'https'] },
  clobberPrefix: '',
  clobber: [],
  strip: ['script', 'style'],
}

/** A reply's HTML parsed, then cut down to `REPLY_SCHEMA`; the addresses that remain go through `replyUrl`. */
export const REPLY_HTML: PluggableList = [rehypeRaw, [rehypeSanitize, REPLY_SCHEMA]]

/**
 * The addresses a reply's links and images may have: absolute web addresses, and mail or a footnote for links. Anything else is
 * dropped, so the link becomes its text and the image its name: `javascript:` and `data:` run or carry content, and a
 * relative address would act on this app's own origin.
 */
export function replyUrl(url: string, key: string): string | undefined {
  // A place in the reply itself (a footnote and its way back) goes nowhere else.
  if (key === 'href' && url.startsWith('#')) return url
  const parsed = URL.parse(url)
  if (parsed === null) return undefined
  const web = parsed.protocol === 'https:' || parsed.protocol === 'http:'
  if (key === 'href') return web || parsed.protocol === 'mailto:' ? url : undefined
  return key === 'src' && web ? url : undefined
}
