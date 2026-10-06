import type { EventHealth } from '@goblin/contracts'
import { eventStatus } from '../lib/labels.ts'
import { relativeTime } from '../lib/threads.ts'
import { StatusLabel } from './status-label.tsx'

const seconds = (ms: number): number => Math.floor(ms / 1000)

/**
 * The events a server sends the agent, each with where its subscription stands and when one last came. Only bounded
 * health metadata is rendered; the events themselves stay inside the Agent.
 */
export function EventsHealth({ events }: { readonly events: readonly EventHealth[] }) {
  if (events.length === 0) return null
  const now = seconds(Date.now())
  return (
    <section className="server-part" aria-label="Events">
      <h3 className="server-part-title">Events</h3>
      <ul className="event-list">
        {events.map((event) => (
          <li key={event.subscriptionId} className="event-row">
            <span className="event-name">{event.name.startsWith('skills.') ? 'Skill updates' : event.name}</span>
            <StatusLabel label={event.granted ? eventStatus(event.status) : { text: 'Paused by you', tone: 'quiet' }} />
            <span className="event-meta">
              {event.lastReceiptAt === null
                ? 'None yet'
                : `Last one ${relativeTime(seconds(event.lastReceiptAt), now)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
