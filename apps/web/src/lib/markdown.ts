// Whether a tool's text output is Markdown worth formatting, judged by the same grammar the renderer parses.

import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

/** The parts of an mdast node detection reads. */
type MdNode = {
  readonly type: string
  readonly position?:
    | { readonly start: { readonly offset?: number | undefined }; readonly end: { readonly line: number } }
    | undefined
  readonly children?: readonly MdNode[]
}
type Source = { readonly text: string; readonly lines: readonly string[] }

const LIMIT = 64 * 1024
/** Every anchor needs one of these: an ATX heading's `#`, a table's `|` or a code fence. */
const CANDIDATE = /[#|]|```|~~~/u
const ANCHORS: ReadonlySet<string> = new Set(['heading', 'code', 'table'])
const parser = unified().use(remarkParse).use(remarkGfm)

/** The source character a node starts at, which tells its written form apart (ATX or setext, fenced or indented). */
const lead = (node: MdNode, source: Source) => source.text.charAt(node.position?.start.offset ?? -1)
/** A Markdown heading stands on its own line; a `# comment` in YAML or a script sits directly on what it describes. */
const spaced = (node: MdNode, source: Source) => /^[\s>]*$/u.test(source.lines[node.position?.end.line ?? 0] ?? '')

/** The node types that count as Markdown, each only in a form plain text rarely takes by accident. */
const SIGNALS = new Map<string, (node: MdNode, source: Source) => boolean>([
  ['heading', (node, source) => lead(node, source) === '#' && spaced(node, source)],
  ['code', (node, source) => lead(node, source) === '`' || lead(node, source) === '~'],
  ['table', () => true],
  ['list', (node) => (node.children?.length ?? 0) > 1],
  ['link', (node, source) => lead(node, source) === '['],
  ['strong', (node, source) => lead(node, source) === '*'],
  ['inlineCode', () => true],
  ['blockquote', () => true],
])

function signals(text: string): ReadonlySet<string> {
  const source: Source = { text, lines: text.split(/\r\n|\r|\n/u) }
  const found = new Set<string>()
  const stack: MdNode[] = [parser.parse(text)]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (SIGNALS.get(node.type)?.(node, source) === true) found.add(node.type)
    for (const child of node.children ?? []) stack.push(child)
  }
  return found
}

/**
 * Whether `text` reads as Markdown: a table, two kinds of anchor (heading, fenced code, table), or one anchor among at
 * least three kinds of signal. Conservative on purpose: a miss leaves readable plain text, a false hit mangles data.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length > LIMIT || !CANDIDATE.test(text)) return false
  const found = signals(text)
  const anchors = [...found].filter((type) => ANCHORS.has(type)).length
  return found.has('table') || anchors >= 2 || (anchors === 1 && found.size >= 3)
}
