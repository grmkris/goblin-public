import { type SubmitEvent, useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { type RoutineDefinition, RoutinePage, RoutineSettings, RoutineView } from '@goblin/contracts'
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
import { failureText, request } from '../lib/boundary.ts'
import { routineStatus } from '../lib/labels.ts'
import { PageSection } from './page-section.tsx'
import { RoutineEditor } from './routine-editor.tsx'
import { RoutineHistory } from './routine-history.tsx'
import { StatusLabel } from './status-label.tsx'

const decodePage = Schema.decodeUnknownSync(RoutinePage)
const decodeView = Schema.decodeUnknownSync(RoutineView)
const decodeSettings = Schema.decodeUnknownSync(RoutineSettings)
const csrf = { 'x-goblin-csrf': '1' }
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
function RoutineTimezone({
  settings,
  onSaved,
}: {
  readonly settings: RoutineSettings
  readonly onSaved: (settings: RoutineSettings) => void
}) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const suggested = browserZone()
  async function save(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const value = new FormData(event.currentTarget).get('timezone')
    if (typeof value !== 'string') return
    setPending(true)
    try {
      const body = { ...settings, timezone: value }
      onSaved(decodeSettings(await request('/api/routines/settings', { method: 'PUT', headers: csrf, body })))
      setOpen(false)
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
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
    <form className="card-body" onSubmit={(event) => void save(event)}>
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
function useRoutineChange(routine: RoutineView, onChange: (routine: RoutineView) => void) {
  const [pending, setPending] = useState<Change>()
  const [error, setError] = useState('')
  async function change(action: Change) {
    setPending(action)
    setError('')
    try {
      const path = `/api/routines/${routine.id}${action === 'archive' ? '' : `/${action}`}`
      const body = { revision: routine.revision, operationId: operation() }
      onChange(
        decodeView(await request(path, { method: action === 'archive' ? 'DELETE' : 'POST', headers: csrf, body })),
      )
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(undefined)
    }
  }
  return { pending, error, change }
}

/** Owner review is an authenticated revisioned API operation, never a model tool confirmation. */
export function RoutineReview({
  routine,
  onChange,
  onEdit,
}: {
  readonly routine: RoutineView
  readonly onChange: (routine: RoutineView) => void
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
              <Button size="sm" pending={pending === 'confirm'} disabled={busy} onClick={() => void change('confirm')}>
                {state === 'paused' ? 'Resume' : 'Confirm'}
              </Button>
            )}
            {(state === 'active' || state === 'activating') && (
              <Button
                size="sm"
                variant="outline"
                pending={pending === 'pause'}
                disabled={busy}
                onClick={() => void change('pause')}
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
              onClick={() => void change('archive')}
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
  const [routines, setRoutines] = useState<readonly RoutineView[]>()
  const [settings, setSettings] = useState<RoutineSettings>()
  const [error, setError] = useState('')
  const load = useCallback(() => {
    void Promise.all([request('/api/routines'), request('/api/routines/settings')])
      .then(([page, config]) => {
        setRoutines(decodePage(page).routines)
        setSettings(decodeSettings(config))
      })
      .catch((cause: unknown) => setError(failureText(cause)))
  }, [])
  useEffect(load, [load])
  const changed = (routine: RoutineView) =>
    setRoutines((current = []) =>
      [routine, ...current.filter((item) => item.id !== routine.id)].filter((item) => item.state !== 'archived'),
    )
  return { routines, settings, setSettings, error, changed }
}

export function RoutinesSection() {
  const { routines, settings, setSettings, error, changed } = useRoutines()
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
          onSaved={(routine) => {
            changed(routine)
            setEditing(undefined)
          }}
        />
      )}
      {listed
        .filter((routine) => editing === undefined || editing === 'new' || routine.id !== editing.id)
        .map((routine) => (
          <RoutineReview key={routine.id} routine={routine} onChange={changed} onEdit={() => setEditing(routine)} />
        ))}
      {settings && <RoutineTimezone settings={settings} onSaved={setSettings} />}
    </PageSection>
  )
}
