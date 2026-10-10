import { type ReactNode, useId } from 'react'

/** One part of the routine editor's form, under a small heading. */
export function EditorPart({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId()
  return (
    <section className="editor-part" aria-labelledby={id}>
      <h3 id={id} className="server-part-title">
        {title}
      </h3>
      {children}
    </section>
  )
}
