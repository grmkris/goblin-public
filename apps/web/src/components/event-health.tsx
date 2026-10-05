import type { EventHealth } from '@purrable/contracts'
import { Badge } from '@purrable/ui'

const statusLabel = (status: string): string => {
  switch (status) {
    case 'active':
      return 'Connected'
    case 'catching_up':
      return 'Catching up'
    case 'pending':
      return 'Connecting'
    case 'terminated':
      return 'Needs reconnect'
    default:
      return 'Paused'
  }
}

const receiptDate = (at: number): string => new Date(at).toLocaleString()

/** Only bounded owner health metadata is rendered; the event itself stays inside the Agent. */
export function EventsHealth({ events }: { readonly events: readonly EventHealth[] }) {
  if (events.length === 0) return null
  return (
    <section className="flex flex-col gap-2" aria-label="Event connections">
      {events.map((event) => (
        <div key={event.subscriptionId} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{event.name.startsWith('skills.') ? 'Skill updates' : event.name}</span>
          <Badge variant="outline">{statusLabel(event.status)}</Badge>
          <span className="text-muted-foreground">{event.granted ? 'Allowed' : 'Paused by owner'}</span>
          {event.refreshBefore !== null && (
            <span className="text-muted-foreground">Lease expires {receiptDate(event.refreshBefore)}</span>
          )}
          <span className="text-muted-foreground">
            {event.lastReceiptAt === null ? 'Awaiting first event' : `Last event ${receiptDate(event.lastReceiptAt)}`}
          </span>
        </div>
      ))}
    </section>
  )
}
