// The layout pieces of goblin's own pages, for an app's view: a section with a small head, and a number with its
// label. Presentation only, without hooks, so the build's render check draws them as the frame does.
import type { ReactNode } from 'react'

/** A part of a view: a small muted head, an optional action beside it, then its content. */
export function Section({
  title,
  action,
  children,
}: {
  readonly title: ReactNode
  readonly action?: ReactNode
  readonly children?: ReactNode
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A number that matters, large and steady, under its label; `note` is a muted line under it. */
export function Stat({
  label,
  value,
  note,
}: {
  readonly label: ReactNode
  readonly value: ReactNode
  readonly note?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-3xl font-semibold tracking-tight tabular-nums">{value}</p>
      {note !== undefined && <p className="text-sm text-muted-foreground">{note}</p>}
    </div>
  )
}
