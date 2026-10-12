// The owner's subscriptions on Home and Limits (ADR 0054): each one's billing (a day pass, or every so many days),
// where it stands, and Cancel, which turns it off on-chain with the owner's own signature. Pro, or whatever the
// merchant sold, runs to the end of the paid period.
import { Button, GoblinMark } from '@goblin/ui'
import type { SubscriptionView } from '@goblin/wallet/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useSubscriptions } from '../api/queries.tsx'
import { useAuth } from '../app/auth.tsx'
import { errorText } from '../ui/async.tsx'
import { ConfirmSheet } from '../ui/index.ts'
import { RowList, Section } from '../ui/page.tsx'
import { billingLine, cancelText, planName, shownSubscriptions, standingOf } from './subscription-model.ts'

function SubscriptionRow({ view }: { readonly view: SubscriptionView }) {
  const auth = useAuth()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const cancel = useMutation({
    mutationFn: () => auth.cancelSubscription(view),
    onSuccess: async () => {
      setOpen(false)
      await Promise.all([
        client.invalidateQueries({ queryKey: ['subscriptions'] }),
        client.invalidateQueries({ queryKey: ['activity'] }),
      ])
    },
  })
  return (
    <li className="flex min-h-16 items-center gap-3 py-3">
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-moss text-moss-foreground"
      >
        <GoblinMark className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium">{planName(view)}</span>
        <span className="text-xs text-muted-foreground tabular-nums text-pretty">{billingLine(view)}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-xs text-muted-foreground tabular-nums">{standingOf(view)}</span>
        {view.status === 'active' && (
          <Button type="button" variant="ghost" className="-me-2.5" onClick={() => setOpen(true)}>
            Cancel
          </Button>
        )}
      </span>
      <ConfirmSheet
        open={open}
        onOpenChange={(next) => {
          if (!cancel.isPending) setOpen(next)
        }}
        title={`Cancel ${planName(view)}?`}
        description={cancelText(view)}
        confirmLabel="Cancel subscription"
        pending={cancel.isPending}
        error={cancel.isError ? errorText(cancel.error) : undefined}
        onConfirm={() => cancel.mutate()}
      />
    </li>
  )
}

/** The subscriptions running from this wallet, under a title; nothing at all when there are none. */
export function Subscriptions() {
  const subscriptions = useSubscriptions()
  const shown = shownSubscriptions(subscriptions.data ?? [])
  if (shown.length === 0) return null
  return (
    <Section title="Subscriptions">
      <RowList>
        <ul className="divide-y divide-border">
          {shown.map((view) => (
            <SubscriptionRow key={view.id} view={view} />
          ))}
        </ul>
      </RowList>
    </Section>
  )
}
