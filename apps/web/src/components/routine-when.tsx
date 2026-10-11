// When a routine runs, as its editor asks it: once at a time the owner picks, on a schedule, or when one of their
// connections sends an event (with filters from the event's own schema); and the trigger those fields make.
import { useQuery } from '@tanstack/react-query'
import type { RoutineDefinition } from '@goblin/contracts'
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  NativeSelect,
  NativeSelectOption,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@goblin/ui'
import { browserZone } from '../lib/format.ts'
import { connectionName } from '../lib/labels.ts'
import { localInput, localInstant } from '../lib/local-time.ts'
import { messageOf } from '../lib/query/app-error.ts'
import type { FormResult } from '../lib/schema-form.ts'
import { eventsQuery, serversQuery } from '../mcp/queries.ts'
import { EditorPart } from './editor-part.tsx'
import { SchemaForm } from './schema-form.tsx'

export type Kind = RoutineDefinition['trigger']['kind']

/** The event a routine waits for: on which connection, which stream, and the filters as the form reports them. */
export type EventChoice = { readonly connectionId: string; readonly name: string; readonly filters: FormResult }

/** What the When fields read from the editor: the routine as it started, the chosen kind, schedule and event. */
export type WhenKit = {
  readonly id: string
  readonly initial: RoutineDefinition
  readonly kind: Kind
  readonly setKind: (kind: Kind) => void
  readonly cron: string
  readonly setCron: (cron: string) => void
  readonly event: EventChoice
  readonly setEvent: (event: EventChoice) => void
}

/** Schedules most people want, as a start for the cron field. */
const PRESETS = [
  { label: 'Every day at 8:00', expression: '0 8 * * *' },
  { label: 'Weekdays at 9:00', expression: '0 9 * * 1-5' },
  { label: 'Mondays at 9:00', expression: '0 9 * * 1' },
] as const

/** A trigger the form cannot make yet, with what to fix. */
type TriggerProblem = { readonly problem: string }

/** The event a routine starts with: its own, or none picked yet. */
export const eventOf = (definition: RoutineDefinition): EventChoice =>
  definition.trigger.kind === 'event'
    ? {
        connectionId: definition.trigger.connectionId,
        name: definition.trigger.name,
        filters: { value: definition.trigger.arguments },
      }
    : { connectionId: '', name: '', filters: { value: {} } }

/**
 * The trigger the form describes, or what to fix first; a reminder's picked wall time becomes an instant with its
 * offset.
 */
export function triggerFrom(
  kind: Kind,
  field: (name: string) => string,
  cron: string,
  event: EventChoice,
): RoutineDefinition['trigger'] | TriggerProblem {
  if (kind === 'cron') return { kind: 'cron', expression: cron }
  if (kind === 'event') {
    if (event.connectionId === '' || event.name === '') return { problem: 'Pick the connection and its event.' }
    if ('problem' in event.filters) return event.filters
    return { kind: 'event', connectionId: event.connectionId, name: event.name, arguments: event.filters.value }
  }
  const at = localInstant(field('at'))
  if (at === undefined) return { problem: 'Pick the date and time it should run.' }
  return { kind: 'once', at }
}

function OnceFields({ kit }: { readonly kit: WhenKit }) {
  const trigger = kit.initial.trigger
  return (
    <Field>
      <FieldLabel htmlFor={`${kit.id}-at`}>Date and time</FieldLabel>
      <Input
        id={`${kit.id}-at`}
        name="at"
        type="datetime-local"
        defaultValue={trigger.kind === 'once' ? localInput(trigger.at) : ''}
        required
      />
      <FieldDescription>In your time, {browserZone()}.</FieldDescription>
    </Field>
  )
}

function CronFields({ kit }: { readonly kit: WhenKit }) {
  return (
    <Field>
      <FieldLabel htmlFor={`${kit.id}-cron`}>Schedule</FieldLabel>
      <div className="card-actions">
        {PRESETS.map((preset) => (
          <Button
            key={preset.expression}
            type="button"
            size="xs"
            variant={kit.cron === preset.expression ? 'secondary' : 'outline'}
            aria-pressed={kit.cron === preset.expression}
            onClick={() => kit.setCron(preset.expression)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <Input
        id={`${kit.id}-cron`}
        value={kit.cron}
        onChange={(event) => kit.setCron(event.target.value)}
        placeholder="0 9 * * 1-5"
        required
      />
      <FieldDescription>
        In cron form: minute, hour, day of the month, month, day of the week. Runs at least 15 minutes apart.
      </FieldDescription>
    </Field>
  )
}

/** The connections that send events, and the one picked if it no longer says so (an edit keeps what it had). */
function useEventConnections(picked: string) {
  const servers = useQuery(serversQuery).data ?? []
  const sending = servers.filter((server) => server.events !== undefined || server.connectionId === picked)
  return sending.map((server) => ({ id: server.connectionId, label: connectionName(server) }))
}

function EventFields({ kit }: { readonly kit: WhenKit }) {
  const { id, event, setEvent } = kit
  const connections = useEventConnections(event.connectionId)
  const streams = useQuery(eventsQuery(event.connectionId === '' ? undefined : event.connectionId))
  const offered = (streams.data ?? []).filter((stream) => stream.subscribable || stream.name === event.name)
  const stream = offered.find((each) => each.name === event.name)
  const unread = streams.error === null ? '' : messageOf(streams.error, 'read the events it sends')
  if (connections.length === 0)
    return <p className="server-note">None of your connections sends events yet. Connect one that does first.</p>
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-event-connection`}>Connection</FieldLabel>
        <NativeSelect
          id={`${id}-event-connection`}
          value={event.connectionId}
          onChange={(change) => setEvent({ connectionId: change.target.value, name: '', filters: { value: {} } })}
          required
        >
          <NativeSelectOption value="">Choose one</NativeSelectOption>
          {connections.map((connection) => (
            <NativeSelectOption key={connection.id} value={connection.id}>
              {connection.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      {event.connectionId !== '' && (
        <Field>
          <FieldLabel htmlFor={`${id}-event-name`}>Event</FieldLabel>
          <NativeSelect
            id={`${id}-event-name`}
            value={event.name}
            onChange={(change) => setEvent({ ...event, name: change.target.value, filters: { value: {} } })}
            required
          >
            <NativeSelectOption value="">{streams.isPending ? 'Reading its events…' : 'Choose one'}</NativeSelectOption>
            {offered.map((each) => (
              <NativeSelectOption key={each.name} value={each.name}>
                {each.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {stream?.description !== undefined && <FieldDescription>{stream.description}</FieldDescription>}
          {unread !== '' && <FieldDescription role="alert">{unread}</FieldDescription>}
        </Field>
      )}
      {event.name !== '' && (
        <SchemaForm
          key={`${event.connectionId}:${event.name}:${String(stream !== undefined)}`}
          id={`${id}-filters`}
          schema={stream?.inputSchema}
          initial={'value' in event.filters ? event.filters.value : {}}
          onChange={(filters) => setEvent({ ...event, filters })}
        />
      )}
    </>
  )
}

export function WhenFields({ kit }: { readonly kit: WhenKit }) {
  const { id, initial } = kit
  return (
    <EditorPart title="When">
      <Tabs value={kit.kind} onValueChange={(value: Kind) => kit.setKind(value)}>
        <TabsList>
          <TabsTrigger value="once">Once</TabsTrigger>
          <TabsTrigger value="cron">Repeats</TabsTrigger>
          <TabsTrigger value="event">On an event</TabsTrigger>
        </TabsList>
        <TabsContent value="once">
          <OnceFields kit={kit} />
        </TabsContent>
        <TabsContent value="cron">
          <CronFields kit={kit} />
        </TabsContent>
        <TabsContent value="event">
          <EventFields kit={kit} />
        </TabsContent>
      </Tabs>
      <Field>
        <FieldLabel htmlFor={`${id}-timezone`}>Timezone</FieldLabel>
        <Input id={`${id}-timezone`} name="timezone" defaultValue={initial.timezone} required />
        <FieldDescription>The schedule follows this zone, and its times show in it.</FieldDescription>
      </Field>
    </EditorPart>
  )
}
