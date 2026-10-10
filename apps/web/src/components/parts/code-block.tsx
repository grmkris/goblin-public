import { type CSSProperties, useEffect, useState } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'
import { useCodeHighlighter } from './code-highlight.ts'

type Highlighter = NonNullable<ReturnType<typeof useCodeHighlighter>>
type Tokens = NonNullable<ReturnType<Highlighter['highlight']>>
type ThemedToken = Tokens['tokens'][number][number]

/** A token in its colour for each theme, as the custom properties styles.css reads (`.code-block`). */
function Token({ token }: { readonly token: ThemedToken }) {
  // With two themes Shiki puts the light colour in the token's style, beside the dark one.
  const light = token.color ?? token.htmlStyle?.['color']
  const dark = token.htmlStyle?.['--shiki-dark']
  const colors: CSSProperties & Record<'--code-light' | '--code-dark', string | undefined> = {
    '--code-light': typeof light === 'string' ? light : undefined,
    '--code-dark': typeof dark === 'string' ? dark : undefined,
  }
  return <span style={colors}>{token.content}</span>
}

/**
 * Shiki's tokens for `code`, once highlighting has loaded and knows the language; until then, none. Tokens are kept with
 * the code they colour, so a block that grew shows plain until its new colours arrive, never colours for other text.
 */
function useTokens(code: string, language: string, live: boolean): Tokens | null {
  const highlighter = useCodeHighlighter()
  const [colored, setColored] = useState<{ readonly code: string; readonly tokens: Tokens }>()
  useEffect(() => {
    if (highlighter === undefined || language === '' || !highlighter.supportsLanguage(language)) return
    const keep = (tokens: Tokens) => setColored({ code, tokens })
    // A cached result comes back at once; otherwise the callback brings it once Shiki has the grammar.
    const ready = highlighter.highlight({ code, language, themes: highlighter.getThemes(), isIncomplete: live }, keep)
    if (ready !== null) keep(ready)
  }, [highlighter, code, language, live])
  return colored?.code === code ? colored.tokens : null
}

/** Copies the block's code, and says so for a moment. The clipboard can refuse; then nothing changes. */
function CopyCode({ code }: { readonly code: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="block-action"
      aria-label={copied ? 'Copied' : 'Copy code'}
      title="Copy code"
      onClick={() => {
        navigator.clipboard.writeText(code).then(
          () => setCopied(true),
          // expected: a refused clipboard leaves the button as it was
          () => undefined,
        )
      }}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </button>
  )
}

/**
 * A code block in a reply: typeset's code, a copy button in its corner, and Shiki's colours for the theme once
 * highlighting has loaded (`code-highlight.ts`). Until then, and for a language Shiki does not know, the code is plain.
 * While `live`, the block is still being written and its highlighting is not kept.
 */
export function CodeBlock({
  code,
  language,
  live,
}: {
  readonly code: string
  readonly language: string
  readonly live: boolean
}) {
  // Markdown ends a block's code with a line break; the block shows, colours and copies the code without it.
  const text = code.endsWith('\n') ? code.slice(0, -1) : code
  const lines = useTokens(text, language, live)?.tokens
  return (
    <div className="code-block">
      <pre>
        <code className={language === '' ? undefined : `language-${language}`}>
          {lines === undefined
            ? text
            : lines.map((line, row) => (
                <span key={row}>
                  {line.map((token, column) => (
                    <Token key={column} token={token} />
                  ))}
                  {row < lines.length - 1 ? '\n' : null}
                </span>
              ))}
        </code>
      </pre>
      <CopyCode code={text} />
    </div>
  )
}
