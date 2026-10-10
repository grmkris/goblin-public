// Fenced code blocks the chat draws. Which fence a streaming reply still has open, Streamdown says per block.

/** The block languages the chat draws instead of showing their code. */
export type BlockKind = 'mermaid' | 'chart' | 'map'

const KINDS: ReadonlySet<string> = new Set<BlockKind>(['mermaid', 'chart', 'map'])
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
