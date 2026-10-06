import type { Label } from '../lib/labels.ts'

/** A state as a small dot in its tone and its words. */
export function StatusLabel({ label }: { readonly label: Label }) {
  return (
    <span className="status-label" data-tone={label.tone}>
      {label.text}
    </span>
  )
}
