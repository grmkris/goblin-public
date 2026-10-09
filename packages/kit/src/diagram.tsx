import { renderMermaidSVG } from 'beautiful-mermaid'
import { type ReactNode, useId, useMemo, useRef, useState } from 'react'
import { DiagramExplorer } from './diagram-explorer.tsx'
import { type Theme, useTheme } from './theme.ts'

/** Longer Mermaid sources stay readable code: layout runs on the page thread. */
const MAX_SOURCE = 20_000
type Colors = {
  readonly bg: string
  readonly fg: string
  readonly accent: string
  readonly muted: string
  readonly border: string
}

const palettes = new Map<Theme, Colors>()

/** The page's tokens as concrete colours: a diagram is an image, and an image cannot read the page's CSS. */
function colorsFor(theme: Theme): Colors {
  const known = palettes.get(theme)
  if (known !== undefined) return known
  const style = getComputedStyle(document.documentElement)
  const token = (name: string) => style.getPropertyValue(name).trim()
  const colors = {
    bg: token('--background'),
    fg: token('--foreground'),
    accent: token('--chart-1'),
    muted: token('--muted-foreground'),
    border: token('--border'),
  }
  palettes.set(theme, colors)
  return colors
}

/**
 * A Mermaid diagram as an SVG document, drawn by beautiful-mermaid, or nothing when the source does not parse. Its
 * unconditional web-font import is dropped: the diagram uses the system font and fetches nothing.
 */
export function diagramSvg(source: string, colors: Colors): string | undefined {
  if (source.length > MAX_SOURCE) return undefined
  try {
    return renderMermaidSVG(source, { ...colors, transparent: true, font: 'system-ui' }).replaceAll(
      /@import\s+url\([^)]*\)\s*;?/gu,
      '',
    )
  } catch {
    // expected: model-written Mermaid that does not parse shows as code (the caller's fallback)
    return undefined
  }
}

/** An inert SVG preview with an optional read-only explorer; unsupported sources show the fallback. */
export function Diagram({
  source,
  fallback,
  interactive = true,
}: {
  readonly source: string
  readonly fallback: ReactNode
  readonly interactive?: boolean
}) {
  const theme = useTheme()
  const scope = `kit-diagram-${useId().replaceAll(/[^a-zA-Z0-9_-]/gu, '-')}`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const svg = useMemo(() => diagramSvg(source, colorsFor(theme)), [source, theme])
  if (svg === undefined) return fallback
  const kind = source.trim().split(/\s/u, 1)[0] ?? 'diagram'
  return (
    <figure className="kit-diagram">
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt={`Diagram (${kind})`} />
      {interactive && (
        <button
          ref={triggerRef}
          type="button"
          className="kit-diagram-explore"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          Explore diagram
        </button>
      )}
      {interactive && open && (
        <DiagramExplorer
          key={`${theme}:${source}`}
          svg={svg}
          scope={scope}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
        />
      )}
    </figure>
  )
}
