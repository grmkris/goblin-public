import type { EventHealth } from '@goblin/contracts'
import { eventWords } from '../lib/events.ts'
import { eventStatus } from '../lib/labels.ts'
import { StatusLabel } from './status-label.tsx'
import { useMinute } from './use-now.ts'
import { relativeTime } from '../lib/format.ts'

const seconds = (ms: number): number => Math.floor(ms / 1000)

/** The events a server sends the agent, as a section of its card; none when it sends none. */
export function EventsHealth({ events }: { readonly events: readonly EventHealth[] }) {
  if (events.length === 0) return null
  return (
    <section className="server-part" aria-label="Events">
      <h3 className="server-part-title">Events</h3>
      <EventsHealthList events={events} />
    </section>
  )
}

/**
 * The events a server sends the agent, each with where its subscription stands and when one last came. Only bounded
 * health metadata is rendered; the events themselves stay inside the Agent.
 */
export function EventsHealthList({ events }: { readonly events: readonly EventHealth[] }) {
  const now = useMinute()
  if (events.length === 0) return null
  return (
    <ul className="event-list">
      {events.map((event) => (
        <li key={event.subscriptionId} className="event-row">
          <span className="event-name">
            {event.name.startsWith('skills.') ? 'Skill updates' : eventWords(event.name)}
          </span>
          <StatusLabel label={event.granted ? eventStatus(event.status) : { text: 'Paused by you', tone: 'quiet' }} />
          <span className="event-meta">
            {event.lastReceiptAt === null ? 'None yet' : `Last one ${relativeTime(seconds(event.lastReceiptAt), now)}`}
          </span>
        </li>
      ))}
    </ul>
  )
}
