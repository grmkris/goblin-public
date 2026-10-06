// Adapted from mdxcn's graph-frame. MIT, Copyright (c) 2026 Keshav Bagaade; see ../vendor/mdxcn/LICENSE.
import { type ReactNode, useId } from 'react'

/** A responsive, labelled frame shared by the five read-only figures. */
export function Frame({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const caption = useId()
  return (
    <figure className="kit-mdxcn not-typeset" aria-labelledby={caption}>
      <figcaption id={caption}>{title}</figcaption>
      <div className="kit-mdxcn-body">{children}</div>
    </figure>
  )
}
