// Adapted from mdxcn's graph-spark. MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import type { SparkSpec } from './mdxcn-spec.ts'
import { Frame } from './mdxcn-frame.tsx'
import { entrance } from './mdxcn-motion.ts'

const GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']

/** A bounded, non-negative spark series, scaled to its maximum; all values remain available to screen readers. */
export function Spark({ title, data, caption }: Omit<SparkSpec, 'kind'>) {
  const max = Math.max(...data, 1)
  return (
    <Frame title={title}>
      <div className="kit-mdxcn-spark" aria-hidden>
        {data.map((value, index) => (
          <span key={index} className="kit-mdxcn-enter" style={entrance(index)} data-last={index === data.length - 1}>
            {GLYPHS[Math.round((value / max) * (GLYPHS.length - 1))]}
          </span>
        ))}
      </div>
      {caption !== undefined && <p className="kit-mdxcn-spark-caption">{caption}</p>}
      <span className="kit-mdxcn-sr">
        Sparkline, {data.length} points: {data.join(', ')}
      </span>
    </Frame>
  )
}
