// Fenced code blocks the chat draws, and the one fence a reply still streaming has open.

/** The block languages the chat draws instead of showing their code. */
export type BlockKind = 'mermaid' | 'chart' | 'map' | 'mdxcn'

const KINDS: ReadonlySet<string> = new Set<BlockKind>(['mermaid', 'chart', 'map', 'mdxcn'])
const isKind = (language: string): language is BlockKind => KINDS.has(language)

/** The block a code element's class names (`language-mermaid` and so on), or nothing for ordinary code. */
export function blockKind(className: unknown): BlockKind | undefined {
  const names = Array.isArray(className)
    ? className.map(String)
    : typeof className === 'string'
      ? className.split(' ')
      : []
  const language = names.find((name) => name.startsWith('language-'))?.slice('language-'.length)
  return language !== undefined && isKind(language) ? language : undefined
}

const OPENING = /^[ \t]*(`{3,}|~{3,})(.*)$/u
const CLOSING = /^[ \t]*(`{3,}|~{3,})[ \t]*$/u

/**
 * Where the text's last code fence opens when nothing closes it yet (CommonMark: the same character, at least as
 * long; at any indentation, so a fence in a list counts), as an offset into `text`; nothing when every fence is
 * closed. A reply still streaming shows that block as code until it is whole.
 */
export function openFenceAt(text: string): number | undefined {
  let open: { readonly mark: string; readonly at: number } | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    if (open === undefined) {
      const opening = OPENING.exec(line)
      const mark = opening?.[1]
      if (mark !== undefined && !(mark.startsWith('`') && (opening?.[2] ?? '').includes('`')))
        open = { mark, at: offset }
    } else {
      const fence = CLOSING.exec(line)?.[1]
      if (fence !== undefined && fence[0] === open.mark[0] && fence.length >= open.mark.length) open = undefined
    }
    offset += line.length + 1
  }
  return open?.at
}
