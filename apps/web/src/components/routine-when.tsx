// When a routine runs, as its editor asks it: once at a time the owner picks, on a schedule, or when a server sends
// an event; and the trigger those fields make.
import { Option, Schema } from 'effect'
import type { RoutineDefinition } from '@goblin/contracts'
import {
  Button,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@goblin/ui'
import { browserZone } from '../lib/format.ts'
import { localInput, localInstant } from '../lib/local-time.ts'
import { EditorPart } from './editor-part.tsx'

export type Kind = RoutineDefinition['trigger']['kind']

/** What the When fields read from the editor: the routine as it started, the chosen kind and the schedule typed. */
export type WhenKit = {
  readonly id: string
  readonly initial: RoutineDefinition
  readonly kind: Kind
  readonly setKind: (kind: Kind) => void
  readonly cron: string
  readonly setCron: (cron: string) => void
  /** The tools the routine may use, whose servers an event can come from. */
  readonly available: readonly { readonly connectionId: string }[]
}

/** Schedules most people want, as a start for the cron field. */
const PRESETS = [
  { label: 'Every day at 8:00', expression: '0 8 * * *' },
  { label: 'Weekdays at 9:00', expression: '0 9 * * 1-5' },
  { label: 'Mondays at 9:00', expression: '0 9 * * 1' },
] as const

/** An event routine's filters: a JSON object, or nothing for every event. */
const decodeFilters = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))
/** A trigger the form cannot make yet, with what to fix. */
type TriggerProblem = { readonly problem: string }

/**
 * The trigger the form describes, or what to fix first; a reminder's picked wall time becomes an instant with its
 * offset.
 */
export function triggerFrom(
  kind: Kind,
  field: (name: string) => string,
  cron: string,
): RoutineDefinition['trigger'] | TriggerProblem {
  if (kind === 'cron') return { kind: 'cron', expression: cron }
  if (kind === 'event') {
    const filters = field('eventArguments').trim()
    const parsed = filters === '' ? Option.some({}) : decodeFilters(filters)
    if (Option.isNone(parsed)) return { problem: 'Write the filters as a JSON object, or leave them empty.' }
    return { kind: 'event', connectionId: field('eventServer'), name: field('eventName'), arguments: parsed.value }
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

function EventFields({ kit }: { readonly kit: WhenKit }) {
  const trigger = kit.initial.trigger
  const servers = [...new Set(kit.available.map((tool) => tool.connectionId))]
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${kit.id}-event-server`}>Server</FieldLabel>
        <Input
          id={`${kit.id}-event-server`}
          name="eventServer"
          list={`${kit.id}-servers`}
          defaultValue={trigger.kind === 'event' ? trigger.connectionId : (servers[0] ?? '')}
          required
          maxLength={64}
        />
        <datalist id={`${kit.id}-servers`}>
          {servers.map((server) => (
            <option key={server} value={server} />
          ))}
        </datalist>
      </Field>
      <Field>
        <FieldLabel htmlFor={`${kit.id}-event-name`}>Event</FieldLabel>
        <Input
          id={`${kit.id}-event-name`}
          name="eventName"
          defaultValue={trigger.kind === 'event' ? trigger.name : ''}
          placeholder="message.received"
          required
          maxLength={256}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${kit.id}-event-args`}>Only events matching (optional)</FieldLabel>
        <Textarea
          id={`${kit.id}-event-args`}
          name="eventArguments"
          defaultValue={trigger.kind === 'event' ? JSON.stringify(trigger.arguments) : ''}
          placeholder="{}"
          maxLength={16_384}
        />
        <FieldDescription>Exact values as JSON, which the server checks for you.</FieldDescription>
      </Field>
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
