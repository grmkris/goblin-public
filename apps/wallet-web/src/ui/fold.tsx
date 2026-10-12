import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@goblin/ui'
import { ChevronDown } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn.ts'

/**
 * A secondary part of a page, folded under a quiet heading: the whole heading row is the toggle (44px tall), with a
 * short summary of what is inside beside it, so the page reads at a glance and the detail is one tap away.
 */
export function Fold({
  id,
  title,
  summary,
  defaultOpen = false,
  children,
  className,
}: {
  /** An anchor another page links to. */
  readonly id?: string
  readonly title: string
  /** What is inside, in a few words or a count. */
  readonly summary?: ReactNode
  readonly defaultOpen?: boolean
  readonly children: ReactNode
  readonly className?: string
}) {
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      className={cn('scroll-mbs-20', className)}
      {...(id === undefined ? {} : { id })}
    >
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="group/fold flex min-h-11 w-full items-center justify-between gap-3 rounded-lg text-start focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        }
      >
        <span className="text-15 font-semibold tracking-tight">{title}</span>
        <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          {summary !== undefined && <span className="truncate tabular-nums">{summary}</span>}
          <ChevronDown
            aria-hidden
            className="size-4 shrink-0 group-data-panel-open/fold:rotate-180 motion-safe:transition-transform"
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 pt-2 pb-1">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
