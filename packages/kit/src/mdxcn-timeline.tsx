// Adapted from mdxcn's graph-timeline. MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import type { TimelineSpec } from './mdxcn-spec.ts'
import { Frame } from './mdxcn-frame.tsx'
import { entrance } from './mdxcn-motion.ts'

/** Dated events, with a quiet connecting rule and the current event in the chart accent. */
export function Timeline({ title, events }: Omit<TimelineSpec, 'kind'>) {
  return (
    <Frame title={title}>
      <ol className="kit-mdxcn-timeline" role="list">
        {events.map((event, index) => (
          <li key={index} className="kit-mdxcn-enter" style={entrance(index)} data-state={event.state ?? 'done'}>
            <span className="kit-mdxcn-mark" aria-hidden>
              {event.state === 'next' ? '○' : '●'}
            </span>
            <span className="kit-mdxcn-date">{event.date}</span>
            <span className="kit-mdxcn-detail">
              <span className="kit-mdxcn-label">{event.label}</span>
              <span className="kit-mdxcn-sr"> ({event.state ?? 'done'})</span>
              {event.note !== undefined && <span className="kit-mdxcn-note">{event.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </Frame>
  )
}
