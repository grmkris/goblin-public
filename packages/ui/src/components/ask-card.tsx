// When the agent waits on the owner (a question, a permission), the request floats above the composer on the same
// chrome material, so it reads as part of the conversation's controls rather than a modal in the way.
import type * as React from 'react'
import { cn } from '../lib/cn'

function AskCard({ className, ...props }: React.ComponentProps<'section'>) {
  return (
    <section
      data-slot="ask-card"
      className={cn(
        'material-chrome flex w-full min-w-0 flex-col gap-3 rounded-2xl border border-border p-4 shadow-lg shadow-black/5 dark:shadow-black/30',
        className,
      )}
      {...props}
    />
  )
}

/** The request in one line, led by an icon: who asks, for what. */
function AskCardHeader({ className, ...props }: React.ComponentProps<'header'>) {
  return (
    <header
      data-slot="ask-card-header"
      className={cn(
        'flex min-w-0 items-start gap-2.5 text-sm [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

function AskCardDescription({ className, ...props }: React.ComponentProps<'p'>) {
  return <p data-slot="ask-card-description" className={cn('text-sm text-muted-foreground', className)} {...props} />
}

function AskCardActions({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="ask-card-actions"
      className={cn('flex flex-wrap items-center justify-end gap-2', className)}
      {...props}
    />
  )
}

export { AskCard, AskCardActions, AskCardDescription, AskCardHeader }
