// A tool call in the transcript: one quiet line of muted text (status, what was used, time), no box, that opens to the
// call's input and output beneath a hairline rule. The status dot is the lifecycle at a glance: queued and stopped are
// muted, running breathes in the live colour, done and failed take the success and destructive tokens.
import type * as React from 'react'
import { Collapsible as CollapsiblePrimitive } from '@base-ui/react/collapsible'
import { cva } from 'class-variance-authority'
import { ChevronRightIcon } from 'lucide-react'
import { cn } from '../lib/cn'
import { PANEL_MOTION } from './collapsible.tsx'

type ToolCallState = 'pending' | 'running' | 'done' | 'error' | 'stopped'

function ToolCall({ className, ...props }: CollapsiblePrimitive.Root.Props) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="tool-call"
      className={cn('group/tool-call w-full min-w-0 text-[0.8125rem]', className)}
      {...props}
    />
  )
}

function ToolCallTrigger({ className, children, ...props }: CollapsiblePrimitive.Trigger.Props) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="tool-call-trigger"
      className={cn(
        'flex min-h-7 w-fit max-w-full min-w-0 items-center gap-2 rounded-lg px-3.5 py-0.5 text-left text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 group-data-open/tool-call:text-foreground pointer-coarse:min-h-11',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 shrink-0 opacity-0 transition-[opacity,rotate] duration-200 group-hover/tool-call:opacity-100 group-data-open/tool-call:rotate-90 group-data-open/tool-call:opacity-100 pointer-coarse:opacity-100"
      />
    </CollapsiblePrimitive.Trigger>
  )
}

const statusVariants = cva('size-1.5 shrink-0 rounded-full', {
  variants: {
    state: {
      pending: 'bg-muted-foreground/40',
      running: 'animate-pulse bg-live',
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
  return <span data-slot="tool-call-title" className={cn('min-w-0 truncate', className)} {...props} />
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

/** The call's input and output, set in by a hairline; `className` styles that column, the panel around it only moves. */
function ToolCallContent({ className, children, ...props }: CollapsiblePrimitive.Panel.Props) {
  return (
    <CollapsiblePrimitive.Panel data-slot="tool-call-content" className={PANEL_MOTION} {...props}>
      <div className={cn('mx-3.5 mt-1 mb-2 flex flex-col gap-2 border-l border-hairline py-1 pl-3', className)}>
        {children}
      </div>
    </CollapsiblePrimitive.Panel>
  )
}

export { ToolCall, ToolCallContent, ToolCallMeta, ToolCallStatus, ToolCallTitle, ToolCallTrigger, type ToolCallState }
