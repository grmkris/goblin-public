import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@goblin/ui'
import { InfoIcon } from 'lucide-react'
import { detailsQuery } from '../../inspect/queries.ts'
import { type DetailStep, detailSteps, detailSummary, durationText, relatedText } from '../../lib/details.ts'
import { describeError, withRef } from '../../lib/query/app-error.ts'
import { QueryError } from '../../lib/query/query-boundary.tsx'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { useOpenChat } from './panel.tsx'

/** One step: what it was, how it ended and how long it took, and a line of detail under it. */
function Step({ step }: { readonly step: DetailStep }) {
  const failed = step.status === 'error' || step.status === 'blocked' || step.status === 'interrupted'
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{step.label}</span>
        <Badge variant={failed ? 'destructive' : 'outline'}>{step.status}</Badge>
        {step.ms !== undefined && <span className="text-muted-foreground tabular-nums">{durationText(step.ms)}</span>}
      </span>
      {step.detail !== undefined && <span className="text-xs text-muted-foreground">{step.detail}</span>}
    </li>
  )
}

/** What the details read found: the operation in a few lines, its steps, what it led to, and what was not recorded. */
function DetailsBody({ chat, entry }: { readonly chat: string; readonly entry: number }) {
  const details = useQuery(detailsQuery(chat, entry))
  const openChat = useOpenChat()
  if (details.isPending)
    return (
      <p role="status" className="text-muted-foreground">
        Reading what happened…
      </p>
    )
  if (details.error !== null) {
    if (describeError(details.error).kind === 'not_found')
      return (
        <p className="text-muted-foreground">{withRef('Nothing is recorded for this message yet.', details.error)}</p>
      )
    return (
      <QueryError
        error={details.error}
        action="read the details"
        onRetry={() => {
          details.refetch().catch(reportUnexpected)
        }}
      />
    )
  }
  const steps = detailSteps(details.data)
  const { related, coverage } = details.data
  return (
    <>
      <div className="flex flex-col gap-0.5">
        {detailSummary(details.data).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
      {steps.length > 0 && (
        <ol className="flex flex-col gap-2" aria-label="What ran">
          {steps.map((step) => (
            <Step key={step.id} step={step} />
          ))}
        </ol>
      )}
      {related.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Related">
          {related.map((each) => (
            <li key={each.operation} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{relatedText(each)}</span>
              {each.chat !== undefined && (
                <Button variant="ghost" size="sm" onClick={() => openChat(each.chat ?? chat)}>
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {!coverage.complete && (
        <p className="text-xs text-muted-foreground">Not everything was recorded: {coverage.gaps.join(', ')}.</p>
      )}
    </>
  )
}

/**
 * The message pill's Details: a sheet of what ran behind message `entry` of `chat` (the inspect `details` read):
 * attempts, tools, timings, errors and flows, and what the message led to. It reads only while it is open.
 */
export function DetailsAction({ chat, entry }: { readonly chat: string; readonly entry: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger render={<button type="button" className="message-action" aria-label="Details" title="Details" />}>
        <InfoIcon aria-hidden />
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Message details</DrawerTitle>
          <DrawerDescription>
            What ran behind this message: attempts, tools, timings, errors and flows.
          </DrawerDescription>
        </DrawerHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4">
          {open && <DetailsBody chat={chat} entry={entry} />}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
