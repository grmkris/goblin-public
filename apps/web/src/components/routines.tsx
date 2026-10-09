import { type SubmitEvent, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RoutineDefinition, RoutineSettings, RoutineView } from '@goblin/contracts'
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
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Skeleton,
} from '@goblin/ui'
import { AlarmClockIcon, PlusIcon } from 'lucide-react'
import { messageOf } from '../lib/query/app-error.ts'
import {
  changeRoutineMutation,
  routineSettingsMutation,
  routineSettingsQuery,
  routinesQuery,
} from '../lib/routines/queries.ts'
import { routineStatus } from '../lib/labels.ts'
import { PageSection } from './page-section.tsx'
import { RoutineEditor } from './routine-editor.tsx'
import { RoutineHistory } from './routine-history.tsx'
import { StatusLabel } from './status-label.tsx'

const operation = () => crypto.randomUUID()
const localTime = (at: number, zone: string) =>
  new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: zone }).format(at)
const count = (value: number) => value.toLocaleString()
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

/** When a routine runs, in words. */
function whenOf(definition: RoutineDefinition): string {
  const trigger = definition.trigger
  if (trigger.kind === 'once') {
    const at = Date.parse(trigger.at)
    return Number.isNaN(at) ? `Once, at ${trigger.at}` : `Once, ${localTime(at, definition.timezone)}`
  }
  if (trigger.kind === 'cron') return `Repeats on the schedule ${trigger.expression}`
  return `When ${trigger.serverId} sends ${trigger.name}`
}

/** The account's routine timezone: a line saying it, opening to a field to change it. */
function RoutineTimezone({ settings }: { readonly settings: RoutineSettings }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const update = useMutation(routineSettingsMutation(queryClient))
  const pending = update.isPending
  const error = update.error === null ? '' : messageOf(update.error, 'change the timezone')
  const suggested = browserZone()
  function save(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('timezone')
    if (typeof value !== 'string') return
    update.mutate({ ...settings, timezone: value }, { onSuccess: () => setOpen(false) })
  }
  if (!open)
    return (
      <p className="section-foot">
        New routines use {settings.timezone}.{' '}
        <Button size="xs" variant="link" onClick={() => setOpen(true)}>
          Change
        </Button>
      </p>
    )
  return (
    <form className="card-body" onSubmit={save}>
      <Field>
        <FieldLabel htmlFor="account-routine-zone">Timezone for new routines</FieldLabel>
        <div className="address-row">
          <Input
            id="account-routine-zone"
            name="timezone"
            defaultValue={settings.timezone === 'UTC' ? suggested : settings.timezone}
            required
          />
          <Button type="submit" size="sm" pending={pending}>
            Save
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        <FieldDescription>Your browser says {suggested}.</FieldDescription>
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

/** What a routine does and may use, as facts beside each other. */
function RoutineDetails({ routine }: { readonly routine: RoutineView }) {
  const { definition } = routine
  const { budget, trigger } = definition
  return (
    <>
      <p className="routine-prompt">{definition.prompt}</p>
      <dl className="routine-facts">
        {routine.nextFireAt !== null && trigger.kind !== 'once' && (
          <div>
            <dt>Next</dt>
            <dd>{localTime(routine.nextFireAt, definition.timezone)}</dd>
          </div>
        )}
        {trigger.kind === 'event' && (
          <div>
            <dt>Only events matching</dt>
            <dd>
              <code>{JSON.stringify(trigger.arguments)}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Tools</dt>
          <dd>
            {definition.allowedTools.length === 0
              ? 'None: it can only answer'
              : definition.allowedTools.map((tool) => `${tool.serverId} · ${tool.name}`).join(', ')}
          </dd>
        </div>
        <div>
          <dt>Limits</dt>
          <dd>
            {count(budget.tokensPerRun)} tokens a run, {count(budget.tokensPerDay)} a day,{' '}
            {Math.round(budget.runtimeSeconds / 60)} minutes at most
          </dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd>{definition.notifyTelegram ? 'Sends its report there too' : 'Off'}</dd>
        </div>
      </dl>
      {routine.health !== null && routine.health !== 'execution_pending' && (
        <p className="server-note">{routine.health}</p>
      )}
    </>
  )
}

type Change = 'confirm' | 'pause' | 'archive'

/** Confirm, Pause, Edit and Archive, each busy while it is under way. */
function useRoutineChange(routine: RoutineView, onChange?: (routine: RoutineView) => void) {
  const queryClient = useQueryClient()
  const changing = useMutation(changeRoutineMutation(queryClient))
  const pending = changing.isPending ? changing.variables.action : undefined
  const error = changing.error === null ? '' : messageOf(changing.error, 'change this routine')
  const change = (action: Change) =>
    changing.mutate(
      { action, id: routine.id, revision: routine.revision, operationId: operation() },
      { onSuccess: (changed) => onChange?.(changed) },
    )
  return { pending, error, change }
}

/** Owner review is an authenticated revisioned API operation, never a model tool confirmation. */
export function RoutineReview({
  routine,
  onChange,
  onEdit,
}: {
  readonly routine: RoutineView
  /** Hears the routine as the agent answers a change; the list on its own page refreshes either way. */
  readonly onChange?: (routine: RoutineView) => void
  readonly onEdit?: () => void
}) {
  const { pending, error, change } = useRoutineChange(routine, onChange)
  const { state, definition } = routine
  const busy = pending !== undefined
  return (
    <Card>
      <CardHeader>
        <CardTitle>{definition.title}</CardTitle>
        <CardDescription>{whenOf(definition)}</CardDescription>
        <CardAction>
          <StatusLabel label={routineStatus(routine)} />
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="card-body">
          <RoutineDetails routine={routine} />
          {state === 'proposed' && <p className="server-note">Nothing runs until you confirm it.</p>}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="card-actions">
            {(state === 'proposed' || state === 'paused') && (
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

function NoRoutines({ onNew }: { readonly onNew: () => void }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <AlarmClockIcon />
        </EmptyMedia>
        <EmptyTitle>No routines yet</EmptyTitle>
        <EmptyDescription>
          A routine is work your agent does on its own: once at a time you pick, on a schedule, or when a server sends
          an event. You can also ask your agent to set one up.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onNew}>New routine</Button>
      </EmptyContent>
    </Empty>
  )
}

/** The owner's routines, newest change first, with the timezone new ones use. */
function useRoutines() {
  const list = useQuery(routinesQuery)
  const settings = useQuery(routineSettingsQuery)
  const failed = list.error ?? settings.error
  return {
    routines: list.data?.routines,
    settings: settings.data,
    error: failed === null ? '' : messageOf(failed, 'list your routines'),
  }
}

export function RoutinesSection() {
  const { routines, settings, error } = useRoutines()
  const [editing, setEditing] = useState<RoutineView | 'new'>()
  const listed = routines ?? []
  return (
    <PageSection
      id="routines"
      title="Routines"
      {...(listed.length > 0 && { count: listed.length })}
      action={
        editing === undefined && listed.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing('new')}>
            <PlusIcon data-icon="inline-start" />
            New routine
          </Button>
        ) : undefined
      }
      note={`Up to ${settings?.maxActive ?? 20} on at once, ${settings?.maxRunning ?? 2} running at a time.`}
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {routines === undefined && <Skeleton className="h-28 w-full" />}
      {routines?.length === 0 && editing === undefined && <NoRoutines onNew={() => setEditing('new')} />}
      {editing !== undefined && (
        <RoutineEditor
          key={editing === 'new' ? 'new' : editing.id}
          timezone={settings === undefined || settings.timezone === 'UTC' ? browserZone() : settings.timezone}
          {...(editing !== 'new' && { routine: editing })}
          onCancel={() => setEditing(undefined)}
          onSaved={() => setEditing(undefined)}
        />
      )}
      {listed
        .filter((routine) => editing === undefined || editing === 'new' || routine.id !== editing.id)
        .map((routine) => (
          <RoutineReview key={routine.id} routine={routine} onEdit={() => setEditing(routine)} />
        ))}
      {settings && <RoutineTimezone settings={settings} />}
    </PageSection>
  )
}
