// A connection's Events (ADR 0041): what is set up on them ("Message received → #Personal", with Pause and Edit), the
// picker for the rest, and its subscriptions' health. While the owner has not answered its offer, it says so and can
// be dismissed.
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { EventStream, RoutineView, ServerView } from '@goblin/contracts'
import { Button } from '@goblin/ui'
import { eventTitle, eventWords, filtersInWords } from '../lib/events.ts'
import { routineStatus } from '../lib/labels.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { dismissEventsMutation, eventsQuery } from '../mcp/queries.ts'
import { changeRoutineMutation, routineSettingsQuery, routinesQuery } from '../routines/queries.ts'
import { EventPicker } from './event-picker.tsx'
import { EventsHealth, EventsHealthList } from './event-health.tsx'
import { RoutineEditor } from './routine-editor.tsx'
import { RoutineReview } from './routine-review.tsx'
import { StatusLabel } from './status-label.tsx'

/** Where a routine on an event goes, in words: the Topic it tells, or who acts on it and where. */
function useRouteLine(): (routine: RoutineView) => string {
  const topics = useTopics()
  const personas = usePersonas()
  return ({ definition, topic }) => {
    const where = `#${topics.find((each) => each.id === topic)?.name ?? 'Personal'}`
    const { handTo } = definition
    if (handTo.kind === 'none') return where
    if (handTo.kind === 'goblin') return `goblin, in ${where}`
    return `@${personas.find((each) => each.id === handTo.persona)?.name ?? 'Persona'}`
  }
}

/** The change a routine's row offers besides Edit: Pause while on, else what turns it (back) on. */
function nextChange(
  routine: RoutineView,
): { readonly action: 'pause' | 'confirm' | 'confirmAgain'; readonly label: string } | undefined {
  const { state, persona } = routine
  if (state === 'active' || state === 'activating') return { action: 'pause', label: 'Pause' }
  if (state !== 'proposed' && state !== 'paused') return undefined
  if (persona?.archived === true) return undefined
  if (persona !== undefined && persona.current !== persona.pinned)
    return { action: 'confirmAgain', label: 'Confirm again' }
  return { action: 'confirm', label: state === 'paused' ? 'Resume' : 'Turn on' }
}

/** One routine on one of the connection's events: "<title> → where", its state, Pause or Resume, and Edit. */
function SetUpRow({
  routine,
  stream,
  onEdit,
}: {
  readonly routine: RoutineView
  readonly stream: EventStream | undefined
  readonly onEdit: () => void
}) {
  const route = useRouteLine()
  const changing = useMutation(changeRoutineMutation)
  const { trigger } = routine.definition
  if (trigger.kind !== 'event') return null
  const title = stream === undefined ? eventWords(trigger.name) : eventTitle(stream)
  const filtered = Object.keys(trigger.arguments).length > 0
  const next = nextChange(routine)
  return (
    <li className="event-set">
      <span className="event-set-text">
        <span className="event-set-title">
          {title} <span className="event-set-route">→ {route(routine)}</span>
        </span>
        {filtered && <span className="event-pick-about">{filtersInWords(trigger.arguments, stream?.inputSchema)}</span>}
        {changing.error !== null && (
          <span className="event-pick-about" role="alert">
            {messageOf(changing.error, 'change it')}
          </span>
        )}
      </span>
      <StatusLabel label={routineStatus(routine)} />
      <span className="row-actions">
        {next !== undefined && (
          <Button
            type="button"
            size="xs"
            variant={next.action === 'pause' ? 'ghost' : 'outline'}
            pending={changing.isPending}
            onClick={() =>
              changing.mutate({
                action: next.action,
                id: routine.id,
                revision: routine.revision,
                operationId: crypto.randomUUID(),
              })
            }
          >
            {next.label}
          </Button>
        )}
        <Button type="button" size="xs" variant="ghost" disabled={changing.isPending} onClick={onEdit}>
          Edit
        </Button>
      </span>
    </li>
  )
}

/** While the owner has not answered the connection's offer: what it is, and Not now. */
function OfferNote({ server }: { readonly server: ServerView }) {
  const dismissing = useMutation(dismissEventsMutation)
  return (
    <div className="event-offer">
      <p className="server-note">
        {server.label} sends events. Pick the ones goblin should tell you about, or hand to goblin or a Persona.
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

/** The routines on a connection's events, and the event names the Telegram channel already takes. */
function useConnectionRoutines(server: ServerView) {
  const routines = (useQuery(routinesQuery).data?.routines ?? []).filter(
    ({ definition: { trigger } }) => trigger.kind === 'event' && trigger.connectionId === server.connectionId,
  )
  const named = new Set(
    routines.flatMap(({ definition: { trigger } }) => (trigger.kind === 'event' ? [trigger.name] : [])),
  )
  const telegram = new Set(
    (server.eventHealth ?? []).filter((health) => health.telegram === true).map((health) => health.name),
  )
  return { routines, named, telegram }
}

/** Where a connection's Events are on its card, for the card summary's Set up. */
export const eventsAnchor = (connectionId: string): string => `events-${connectionId}`

/**
 * The Events of a connected server that sends them: its offer while open, what is set up on its events (each editable
 * in place, then confirmed on its card here), the picker for the rest, and its subscriptions' health. A server that
 * sends no events shows only its subscriptions' health, if any.
 */
export function ConnectionEvents({ server }: { readonly server: ServerView }) {
  const streams = useQuery(eventsQuery(server.events === undefined ? undefined : server.connectionId))
  const { routines, named, telegram } = useConnectionRoutines(server)
  const timezone = useQuery(routineSettingsQuery).data?.timezone ?? 'UTC'
  const [editing, setEditing] = useState<RoutineView>()
  const [saved, setSaved] = useState<RoutineView>()
  if (server.events === undefined) return <EventsHealth events={server.eventHealth ?? []} />
  const offered = (streams.data ?? []).filter((stream) => stream.subscribable)
  const streamOf = (routine: RoutineView) =>
    offered.find(
      (stream) => routine.definition.trigger.kind === 'event' && stream.name === routine.definition.trigger.name,
    )
  return (
    <section className="server-part" id={eventsAnchor(server.connectionId)} aria-label="Events">
      <h3 className="server-part-title">Events</h3>
      {server.events === 'open' && <OfferNote server={server} />}
      {streams.error !== null && <p className="server-note">{messageOf(streams.error, 'read the events it sends')}</p>}
      {streams.isPending && (
        <p className="server-note" role="status">
          Reading its events…
        </p>
      )}
      {routines.length > 0 && (
        <ul className="event-sets">
          {routines.map((routine) => (
            <SetUpRow
              key={routine.id}
              routine={routine}
              stream={streamOf(routine)}
              onEdit={() => {
                setSaved(undefined)
                setEditing(routine)
              }}
            />
          ))}
        </ul>
      )}
      {editing !== undefined && (
        <RoutineEditor
          timezone={timezone}
          routine={editing}
          onSaved={(routine) => {
            setEditing(undefined)
            setSaved(routine)
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {saved !== undefined && <RoutineReview routine={routines.find((each) => each.id === saved.id) ?? saved} />}
      <EventPicker server={server} streams={offered.filter((stream) => !named.has(stream.name))} telegram={telegram} />
      <EventsHealthList events={server.eventHealth ?? []} />
    </section>
  )
}
