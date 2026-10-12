import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@goblin/ui'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from './cn.ts'

/** A page's title and what it is for, then its sections. Pages are a single readable column that widens a little. */
export function Page({
  title,
  description,
  action,
  children,
}: {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description !== undefined && (
            <p className="max-w-prose text-sm/relaxed text-muted-foreground text-pretty">{description}</p>
          )}
        </div>
        {action}
      </header>
      {children}
    </div>
  )
}

export function Section({
  id,
  title,
  action,
  children,
  className,
}: {
  /** An anchor another part of the page links to. */
  readonly id?: string
  readonly title: string
  readonly action?: ReactNode
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <section id={id} className={cn('flex scroll-mbs-20 flex-col gap-3', className)}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** A card-like surface for a list of rows separated by hairlines. */
export function RowList({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'flex flex-col divide-y divide-border rounded-xl bg-card px-4 text-card-foreground ring-1 ring-foreground/10',
        className,
      )}
      {...props}
    />
  )
}

/** Nothing here yet, and what to do about it. */
export function EmptyState({ title, description }: { readonly title: string; readonly description: string }) {
  return (
    <div className="flex rounded-xl border border-dashed border-border">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  )
}
