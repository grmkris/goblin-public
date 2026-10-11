// A connection's Events (ADR 0041): what its server sends, what goblin does with each (the routines on it), and
// setting one up in place. While the owner has not answered its offer, it says so and can be dismissed.
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { EventStream, RoutineDefinition, RoutineView, ServerView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { routineStatus } from '../lib/labels.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { dismissEventsMutation, eventsQuery } from '../mcp/queries.ts'
import { routineSettingsQuery, routinesQuery } from '../routines/queries.ts'
import { EventsHealth, EventsHealthList } from './event-health.tsx'
import { RoutineEditor } from './routine-editor.tsx'
import { RoutineReview } from './routine-review.tsx'
import { StatusLabel } from './status-label.tsx'

/** A routine on one of the connection's streams, in a line: what it does with the event, and where. */
function useRoutineLine(): (routine: RoutineView) => string {
  const topics = useTopics()
  const personas = usePersonas()
  return ({ definition, topic }) => {
    const where = `#${topics.find((each) => each.id === topic)?.name ?? 'Personal'}`
    const { handTo, tellMe } = definition
    const told = tellMe.on ? `Tell me in ${where}` : ''
    const handed =
      handTo.kind === 'none'
        ? ''
        : handTo.kind === 'goblin'
          ? `Hand to Goblin in ${where}`
          : `Hand to @${personas.find((each) => each.id === handTo.persona)?.name ?? 'Persona'}`
    return [told, handed].filter((part) => part !== '').join(' · ')
  }
}

/** A new routine on stream `name`: it tells the owner, in Personal, until they change it. */
const draftOf = (server: ServerView, name: string, timezone: string): RoutineDefinition => ({
  title: `${name} · ${server.label}`.slice(0, 120),
  timezone,
  trigger: { kind: 'event', connectionId: server.connectionId, name, arguments: {} },
  tellMe: { on: true, telegram: false },
  handTo: { kind: 'none' },
})

/** One stream: its name and the server's words for it, the routines on it, and Set up. */
function StreamRow({
  stream,
  routines,
  onSetUp,
}: {
  readonly stream: EventStream
  readonly routines: readonly RoutineView[]
  readonly onSetUp: () => void
}) {
  const line = useRoutineLine()
  return (
    <li className="event-stream">
      <span className="event-stream-head">
        <span className="event-name">{stream.name}</span>
        <Button type="button" size="xs" variant="outline" onClick={onSetUp}>
          Set up
        </Button>
      </span>
      {stream.description !== undefined && <span className="event-meta">{stream.description}</span>}
      {routines.map((routine) => (
        <span key={routine.id} className="event-routine">
          <span>
            When {stream.name} → {line(routine)}
          </span>
          <StatusLabel label={routineStatus(routine)} />
        </span>
      ))}
    </li>
  )
}

/** While the owner has not answered the connection's offer: what it is, and Dismiss. */
function OfferNote({ server }: { readonly server: ServerView }) {
  const dismissing = useMutation(dismissEventsMutation)
  return (
    <div className="event-offer">
      <p className="server-note">
        {server.label} sends events. Choose what goblin does with them: tell you, hand them to Goblin or a Persona, or
        both.
      </p>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        pending={dismissing.isPending}
        onClick={() => dismissing.mutate(server.connectionId)}
      >
        Not now
      </Button>
      {dismissing.error !== null && <p className="server-note">{messageOf(dismissing.error, 'dismiss it')}</p>}
    </div>
  )
}

/**
 * The Events of a connected server that sends them: its offer while open, each stream with the routines on it, a
 * routine set up in place (then confirmed on its card here), and its subscriptions' health. A server that sends no
 * events shows only its subscriptions' health, if any.
 */
export function ConnectionEvents({ server }: { readonly server: ServerView }) {
  const streams = useQuery(eventsQuery(server.events === undefined ? undefined : server.connectionId))
  const routines = (useQuery(routinesQuery).data?.routines ?? []).filter(
    ({ definition: { trigger } }) => trigger.kind === 'event' && trigger.connectionId === server.connectionId,
  )
  const timezone = useQuery(routineSettingsQuery).data?.timezone ?? 'UTC'
  const [setting, setSetting] = useState<string>()
  const [saved, setSaved] = useState<RoutineView>()
  if (server.events === undefined) return <EventsHealth events={server.eventHealth ?? []} />
  const on = (name: string) =>
    routines.filter(({ definition: { trigger } }) => trigger.kind === 'event' && trigger.name === name)
  return (
    <section className="server-part" aria-label="Events">
      <h3 className="server-part-title">Events</h3>
      {server.events === 'open' && <OfferNote server={server} />}
      {streams.error !== null && <p className="server-note">{messageOf(streams.error, 'read the events it sends')}</p>}
      <ul className="event-streams">
        {(streams.data ?? [])
          .filter((stream) => stream.subscribable)
          .map((stream) => (
            <StreamRow
              key={stream.name}
              stream={stream}
              routines={on(stream.name)}
              onSetUp={() => {
                setSaved(undefined)
                setSetting(stream.name)
              }}
            />
          ))}
      </ul>
      {setting !== undefined && (
        <RoutineEditor
          timezone={timezone}
          draft={draftOf(server, setting, timezone)}
          onSaved={(routine) => {
            setSetting(undefined)
            setSaved(routine)
          }}
          onCancel={() => setSetting(undefined)}
        />
      )}
      {saved !== undefined && <RoutineReview routine={routines.find((each) => each.id === saved.id) ?? saved} />}
      <EventsHealthList events={server.eventHealth ?? []} />
    </section>
  )
}
