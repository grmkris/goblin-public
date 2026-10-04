// A tool call in the transcript: one quiet row (status, name, time) that opens to the call's input and output. The
// status dot is the lifecycle at a glance: queued and stopped are muted, running breathes, done and failed take the
// success and destructive tokens.
import type * as React from 'react'
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { cva } from 'class-variance-authority'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '../lib/cn'

type ToolCallState = 'pending' | 'running' | 'done' | 'error' | 'stopped'

function ToolCall({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="tool-call"
      className={cn(
        'group/tool-call w-full min-w-0 rounded-xl border border-border/70 bg-card/40 text-sm transition-colors data-open:bg-card',
        className,
      )}
      {...props}
    />
  )
}

function ToolCallTrigger({ className, children, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="tool-call-trigger"
      className={cn(
        'flex min-h-9 w-full min-w-0 items-center gap-2.5 rounded-xl px-3 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-open/tool-call:rotate-90"
      />
    </CollapsiblePrimitive.Trigger>
  )
}

const statusVariants = cva('size-2 shrink-0 rounded-full', {
  variants: {
    state: {
      pending: 'bg-muted-foreground/40',
      running: 'animate-pulse bg-primary',
      done: 'bg-success',
      error: 'bg-destructive',
      stopped: 'bg-muted-foreground/40',
    },
  },
})

const STATUS_LABEL: Record<ToolCallState, string> = {
  pending: 'Queued',
  running: 'Running',
  done: 'Done',
  error: 'Failed',
  stopped: 'Stopped',
}

function ToolCallStatus({ state }: { readonly state: ToolCallState }) {
  return (
    <span data-slot="tool-call-status" className={statusVariants({ state })}>
      <span className="sr-only">{STATUS_LABEL[state]}</span>
    </span>
  )
}

function ToolCallTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="tool-call-title" className={cn('min-w-0 truncate font-medium', className)} {...props} />
}

function ToolCallMeta({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="tool-call-meta"
      className={cn('shrink-0 text-xs text-muted-foreground tabular-nums', className)}
      {...props}
    />
  )
}

function ToolCallContent({ className, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel
      data-slot="tool-call-content"
      className={cn('flex flex-col gap-2 border-t border-border/70 px-3 py-2.5', className)}
      {...props}
    />
  )
}

export { ToolCall, ToolCallContent, ToolCallMeta, ToolCallStatus, ToolCallTitle, ToolCallTrigger, type ToolCallState }
