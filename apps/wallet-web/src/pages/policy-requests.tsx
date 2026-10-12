import { Alert, AlertDescription, Button, Spinner } from '@goblin/ui'
import type { PolicyChange } from '@goblin/wallet/contract'
import { useDecidePolicyChange, usePolicyChanges } from '../api/queries.tsx'
import { Async, errorText } from '../ui/async.tsx'
import { Fold } from '../ui/fold.tsx'
import { timeAgo } from '../ui/index.ts'
import { RowList } from '../ui/page.tsx'

const DECIDED_SHOWN = 5

function PendingRow({ request }: { readonly request: PolicyChange }) {
  const decide = useDecidePolicyChange(request.id)
  return (
    <li className="flex flex-col gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{request.change}</span>
        <span className="text-sm text-muted-foreground text-pretty">{request.reason}</span>
        <span className="text-xs text-muted-foreground">
          {request.client}, {timeAgo(request.createdAt)}
        </span>
      </div>
      {decide.isError && (
        <Alert variant="destructive">
          <AlertDescription>{errorText(decide.error)}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={decide.isPending} onClick={() => decide.mutate('applied')}>
          {decide.isPending && <Spinner data-icon="inline-start" />}
          Mark done
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={decide.isPending}
          onClick={() => decide.mutate('dismissed')}
        >
          Dismiss
        </Button>
      </div>
    </li>
  )
}

function DecidedRow({ request }: { readonly request: PolicyChange }) {
  return (
    <li className="flex items-baseline justify-between gap-4 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">{request.change}</span>
      <span className="shrink-0">
        {request.status === 'applied' ? 'Done' : 'Dismissed'}, {timeAgo(request.createdAt)}
      </span>
    </li>
  )
}

function Requests({ rows }: { readonly rows: readonly PolicyChange[] }) {
  const pending = rows.filter((row) => row.status === 'pending')
  const decided = rows.filter((row) => row.status !== 'pending').slice(0, DECIDED_SHOWN)
  if (rows.length === 0)
    return <p className="px-1 text-sm text-muted-foreground">Your agent has not asked for any changes.</p>
  return (
    <>
      {pending.length > 0 && (
        <RowList>
          <ul className="divide-y divide-border">
            {pending.map((request) => (
              <PendingRow key={request.id} request={request} />
            ))}
          </ul>
        </RowList>
      )}
      {pending.length > 0 && (
        <p className="px-1 text-xs text-muted-foreground text-pretty">
          Make the change yourself above, then mark it done. Nothing changes until you do.
        </p>
      )}
      {decided.length > 0 && (
        <ul className="flex flex-col divide-y divide-border px-1" aria-label="Answered requests">
          {decided.map((request) => (
            <DecidedRow key={request.id} request={request} />
          ))}
        </ul>
      )}
    </>
  )
}

/**
 * What the agent asked to change through `request_policy_change`; the owner makes the change and answers here. Folded
 * unless something waits, so a request is never missed and an answered one never crowds the page.
 */
export function PolicyRequests() {
  const requests = usePolicyChanges()
  const pending = requests.data?.filter((row) => row.status === 'pending').length ?? 0
  const waiting = (
    <span className="inline-flex items-center gap-1.5 text-foreground">
      <span aria-hidden className="size-1.5 rounded-full bg-attention" />
      {pending} waiting
    </span>
  )
  return (
    <Fold
      // Remounted once the requests load, so a waiting one opens the fold.
      key={pending > 0 ? 'waiting' : 'none'}
      title="Requests from your agent"
      {...(pending > 0 ? { summary: waiting } : {})}
      defaultOpen={pending > 0}
    >
      <Async query={requests} rows={1}>
        {(rows) => <Requests rows={rows} />}
      </Async>
    </Fold>
  )
}
