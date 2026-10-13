// A routine's card: what it does and when, its facts, and the owner's Confirm, Pause, Edit and Archive, with its runs.
import { useMutation, useQuery } from '@tanstack/react-query'
import { type RoutineDefinition, type RoutinePersona, type RoutineView, handOverOf } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@goblin/ui'
import { eventTitle, eventWords, filtersInWords } from '../lib/events.ts'
import { dateTime } from '../lib/format.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { useConnectionLabels } from '../mcp/hooks.ts'
import { routineStatus } from '../lib/labels.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { eventsQuery, serversQuery } from '../mcp/queries.ts'
import { changeRoutineMutation } from '../routines/queries.ts'
import { RoutineHistory } from './routine-history.tsx'
import { StatusLabel } from './status-label.tsx'

const operation = () => crypto.randomUUID()
const count = (value: number) => value.toLocaleString()

/**
 * When a routine runs, in words; an event names its connection as the owner does (`connection`) and the event by its
 * title (`event`).
 */
function whenOf(definition: RoutineDefinition, connection: (id: string) => string, event: string | undefined): string {
  const trigger = definition.trigger
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at)
    return Number.isNaN(at) ? `Once, at ${trigger.at}` : `Once, ${dateTime(at, definition.timezone)}`
  }
  if (trigger.kind === 'cron') return `Repeats on the schedule ${trigger.expression}`
  return `When ${connection(trigger.connectionId)} sends “${event ?? eventWords(trigger.name)}”`
}

/** When a routine runs, in words, with its connection's label and its event's title as they are now. */
function useWhenOf(definition: RoutineDefinition): string {
  const connection = useConnectionLabels()
  const stream = useStreamOf(definition)
  return whenOf(definition, connection, stream === undefined ? undefined : eventTitle(stream))
}

/**
 * The event stream a routine waits for, as its server describes it now (its title and filter schema); none for a
 * routine on no event, or while the server has not said. Only a connected connection is asked: one that needs sign-in
 * refuses (403), and a review is read on every Settings load.
 */
function useStreamOf(definition: RoutineDefinition) {
  const { trigger } = definition
  const from = trigger.kind === 'event' ? trigger.connectionId : undefined
  const servers = useQuery(serversQuery).data
  const connected = servers?.some((server) => server.connectionId === from && server.status === 'connected') === true
  const streams = useQuery(eventsQuery(connected ? from : undefined))
  return trigger.kind === 'event' ? streams.data?.find((stream) => stream.name === trigger.name) : undefined
}

/** Whether a routine tells the owner, in words (ADR 0041). */
const tellMeOf = (tellMe: RoutineDefinition['tellMe']): string =>
  !tellMe.on ? 'Off' : tellMe.telegram ? 'In Activity, and on Telegram' : 'In Activity'

/** Who a routine hands its work to, in words: Goblin, or the Persona by name at the pinned revision. */
function useHandedTo(definition: RoutineDefinition): string | undefined {
  const personas = usePersonas()
  const { handTo } = definition
  if (handTo.kind === 'none') return undefined
  if (handTo.kind === 'goblin') return 'goblin'
  const name = personas.find((persona) => persona.id === handTo.persona)?.name ?? `Persona ${String(handTo.persona)}`
  return `@${name}, revision ${String(handTo.revision)}`
}

/** What a routine does and may use, as facts beside each other. */
function RoutineDetails({ routine }: { readonly routine: RoutineView }) {
  const { definition } = routine
  const { trigger } = definition
  const handOver = handOverOf(definition)
  const handedTo = useHandedTo(definition)
  const topic = useTopics().find((each) => each.id === routine.topic)
  const stream = useStreamOf(definition)
  return (
    <>
      {handOver !== undefined && <p className="routine-prompt">{handOver.instruction}</p>}
      <dl className="routine-facts">
        {handedTo !== undefined && (
          <div>
            <dt>Hand to</dt>
            <dd>{handedTo}</dd>
          </div>
        )}
        {routine.nextFireAt !== null && trigger.kind !== 'once' && (
          <div>
            <dt>Next</dt>
            <dd>{dateTime(routine.nextFireAt, definition.timezone)}</dd>
          </div>
        )}
        {trigger.kind === 'event' && (
          <div>
            <dt>Which ones</dt>
            <dd>{filtersInWords(trigger.arguments, stream?.inputSchema)}</dd>
          </div>
        )}
        {handOver !== undefined && (
          <div>
            <dt>Tools</dt>
            <dd>
              {handOver.allowedTools.length === 0
                ? 'None: it can only answer'
                : handOver.allowedTools.map((tool) => `${tool.connectionId} · ${tool.name}`).join(', ')}
            </dd>
          </div>
        )}
        {routine.outsideSetup.length > 0 && (
          <div>
            <dt>Not in its Topic</dt>
            <dd>
              {routine.outsideSetup.map((tool) => `${tool.connectionId} · ${tool.name}`).join(', ')}: its Topic's MCP
              servers & skills leave these out, so a run that calls one is refused.
            </dd>
          </div>
        )}
        {handOver !== undefined && (
          <div>
            <dt>Limits</dt>
            <dd>
              {count(handOver.budget.tokensPerRun)} tokens a run, {count(handOver.budget.tokensPerDay)} a day,{' '}
              {Math.round(handOver.budget.runtimeSeconds / 60)} minutes at most
            </dd>
          </div>
        )}
        <div>
          <dt>Tell me</dt>
          <dd>{tellMeOf(definition.tellMe)}</dd>
        </div>
        {topic !== undefined && (
          <div>
            <dt>Topic</dt>
            <dd>#{topic.name}</dd>
          </div>
        )}
      </dl>
      {routine.health !== null &&
        routine.health !== 'execution_pending' &&
        !Object.hasOwn(PERSONA_HEALTH, routine.health) && <p className="server-note">{routine.health}</p>}
    </>
  )
}

/** A routine's health that only says its Persona is gone or changed: the Persona's own note says it better. */
const PERSONA_HEALTH = { persona_archived: true, persona_changed: true } as const

/**
 * Why a routine handed to a Persona waits for the owner (ADR 0041): the Persona was archived, or changed since the
 * routine pinned it; none while it is as pinned.
 */
function personaNote(persona: RoutinePersona | undefined): string | undefined {
  if (persona === undefined) return undefined
  const name = persona.name === '' ? 'Its Persona' : `@${persona.name}`
  if (persona.archived) return `${name} is archived, so this routine cannot run. Hand it to someone else to use it.`
  if (persona.current === persona.pinned) return undefined
  return `${name} changed since you confirmed this routine (revision ${String(persona.pinned)} → ${String(persona.current)}). It does not run until you confirm it again with ${name} as it is now.`
}

type Change = 'confirm' | 'confirmAgain' | 'pause' | 'archive'

/** Confirm, Pause, Edit and Archive, each busy while it is under way; the routines read again once it lands. */
function useRoutineChange(routine: RoutineView) {
  const changing = useMutation(changeRoutineMutation)
  const pending = changing.isPending ? changing.variables.action : undefined
  const error = changing.error === null ? '' : messageOf(changing.error, 'change this routine')
  const change = (action: Change) =>
    changing.mutate({ action, id: routine.id, revision: routine.revision, operationId: operation() })
  return { pending, error, change }
}

/** Owner review is an authenticated revisioned API operation, never a model tool confirmation. */
export function RoutineReview({ routine, onEdit }: { readonly routine: RoutineView; readonly onEdit?: () => void }) {
  const { pending, error, change } = useRoutineChange(routine)
  const { state, definition } = routine
  const busy = pending !== undefined
  const persona = personaNote(routine.persona)
  const when = useWhenOf(definition)
  const repin = persona !== undefined && routine.persona?.archived === false && state !== 'archived'
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="routine-title">{definition.title}</span>
        </CardTitle>
        <CardDescription>
          <span className="routine-title">{when}</span>
        </CardDescription>
        <CardAction>
          <StatusLabel label={routineStatus(routine)} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <RoutineDetails routine={routine} />
          {persona !== undefined && <p className="server-note">{persona}</p>}
          {state === 'proposed' && !repin && <p className="server-note">Nothing runs until you confirm it.</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="card-actions">
            {repin && (
              <Button
                size="sm"
                pending={pending === 'confirmAgain'}
                disabled={busy}
                onClick={() => change('confirmAgain')}
              >
                Confirm again
              </Button>
            )}
            {!repin && routine.persona?.archived !== true && (state === 'proposed' || state === 'paused') && (
              <Button size="sm" pending={pending === 'confirm'} disabled={busy} onClick={() => change('confirm')}>
                {state === 'paused' ? 'Resume' : 'Confirm'}
              </Button>
            )}
            {(state === 'active' || state === 'activating') && (
              <Button
                size="sm"
                variant="outline"
                pending={pending === 'pause'}
                disabled={busy}
                onClick={() => change('pause')}
              >
                Pause
              </Button>
            )}
            {onEdit && (
              <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
                Edit
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              pending={pending === 'archive'}
              disabled={busy}
              onClick={() => change('archive')}
            >
              Archive
            </Button>
          </div>
          <RoutineHistory id={routine.id} revision={routine.revision} active={state === 'active'} />
        </div>
      </CardContent>
    </Card>
  )
}
