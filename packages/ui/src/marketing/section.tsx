// One part of a marketing page's story: a heading and a little copy on one side, one real visual (a screenshot, a
// fragment of the product's UI) on the other. Asymmetric on a desktop, five columns of copy beside seven of visual, and
// `flip` swaps the sides so a page does not march down one edge; on a phone, the copy, then its visual.
import { type ReactNode, useId } from 'react'

export interface SectionProps {
  readonly id?: string
  readonly title: ReactNode
  /** The copy under the heading: paragraphs, a short list, a link. */
  readonly children: ReactNode
  readonly visual: ReactNode
  readonly flip?: boolean
}

export function Section({ id, title, children, visual, flip = false }: SectionProps) {
  const titleId = useId()
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      data-slot="section"
      data-flip={flip ? '' : undefined}
      className="site-width site-section"
    >
      <div className="site-section-copy">
        <h2 id={titleId} className="site-heading">
          {title}
        </h2>
        <div className="site-body site-section-text">{children}</div>
      </div>
      <div className="site-section-visual">{visual}</div>
    </section>
  )
}
