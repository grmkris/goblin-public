// Adapted from mdxcn's graph-stat. MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import type { StatSpec } from './mdxcn-spec.ts'
import { Frame } from './mdxcn-frame.tsx'
import { entrance } from './mdxcn-motion.ts'

/** Compact values with labels and optional hints; the grid follows its pane's width. */
export function Stat({ title, items }: Omit<StatSpec, 'kind'>) {
  return (
    <Frame title={title}>
      <ul className="kit-mdxcn-stats" role="list">
        {items.map((entry, index) => (
          <li key={index} className="kit-mdxcn-enter" style={entrance(index)}>
            <span className="kit-mdxcn-value" data-accent={entry.accent === true}>
              {entry.value}
            </span>
            <span className="kit-mdxcn-note">{entry.label}</span>
            {entry.hint !== undefined && <span className="kit-mdxcn-note">{entry.hint}</span>}
          </li>
        ))}
      </ul>
    </Frame>
  )
}
