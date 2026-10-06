import type { ReactNode, Ref } from 'react'

/**
 * A section of a page outside the workspace (Connections, Settings): a heading with an optional count and action, an
 * optional note under it, then its cards.
 */
export function PageSection({
  id,
  title,
  count,
  action,
  note,
  ref,
  children,
}: {
  readonly id: string
  readonly title: string
  readonly count?: number
  readonly action?: ReactNode
  readonly note?: ReactNode
  readonly ref?: Ref<HTMLElement>
  readonly children: ReactNode
}) {
  return (
    <section className="page-section" aria-labelledby={`${id}-title`} ref={ref}>
      <div className="section-head">
        <h2 id={`${id}-title`}>
          {title}
          {count !== undefined && <span className="section-count">{count}</span>}
        </h2>
        {action}
      </div>
      {note !== undefined && <p className="section-note">{note}</p>}
      {children}
    </section>
  )
}
