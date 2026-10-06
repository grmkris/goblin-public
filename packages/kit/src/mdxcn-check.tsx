// Adapted from mdxcn's graph-check. MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import type { CheckSpec } from './mdxcn-spec.ts'
import { Frame } from './mdxcn-frame.tsx'
import { entrance } from './mdxcn-motion.ts'

type Item = {
  readonly label: string
  readonly done?: boolean | undefined
  readonly note?: string | undefined
  readonly items?: readonly Item[] | undefined
}

function flattened(items: readonly Item[]): readonly Item[] {
  return items.flatMap((item) => [item, ...flattened(item.items ?? [])])
}

function CheckRow({
  entry,
  index,
  nested = false,
}: {
  readonly entry: Item
  readonly index: number
  readonly nested?: boolean
}) {
  return (
    <li className={nested ? 'kit-mdxcn-check-row' : 'kit-mdxcn-check-row kit-mdxcn-enter'} style={entrance(index)}>
      <span className="kit-mdxcn-check-mark" data-done={entry.done === true} aria-hidden>
        {entry.done ? '[x]' : '[ ]'}
      </span>
      <div className="kit-mdxcn-detail">
        <span>
          {entry.label}
          <span className="kit-mdxcn-sr"> ({entry.done ? 'done' : 'pending'})</span>
        </span>
        {entry.note !== undefined && <span className="kit-mdxcn-note">{entry.note}</span>}
        {entry.items !== undefined && entry.items.length > 0 && (
          <ul className="kit-mdxcn-check" role="list">
            {entry.items.map((child, at) => (
              <CheckRow key={at} entry={child} index={at} nested />
            ))}
          </ul>
        )}
      </div>
    </li>
  )
}

/** A checklist display, including bounded sub-tasks; it has no checkbox action or mutation. */
export function Check({ title, items }: Omit<CheckSpec, 'kind'>) {
  const all = flattened(items)
  return (
    <Frame title={title}>
      <ul className="kit-mdxcn-check" role="list">
        {items.map((entry, index) => (
          <CheckRow key={index} entry={entry} index={index} />
        ))}
      </ul>
      <span className="kit-mdxcn-sr">
        {all.filter((entry) => entry.done).length} of {all.length} done
      </span>
    </Frame>
  )
}
