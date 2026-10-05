import { useCallback, useEffect, useState } from 'react'
import { Schema } from 'effect'
import { RoutinePage, RoutineSettings, RoutineView } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
} from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'
import { RoutineEditor } from './routine-editor.tsx'
import { RoutineHistory } from './routine-history.tsx'

const decodePage = Schema.decodeUnknownSync(RoutinePage)
const decodeView = Schema.decodeUnknownSync(RoutineView)
const decodeSettings = Schema.decodeUnknownSync(RoutineSettings)
const csrf = { 'x-purrable-csrf': '1' }
const operation = () => crypto.randomUUID()
const localTime = (at: number | null, zone: string) =>
  at === null
    ? '—'
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long', timeZone: zone }).format(at)

function RoutineTimezone({
  settings,
  onSaved,
}: {
  readonly settings: RoutineSettings
  readonly onSaved: (settings: RoutineSettings) => void
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const suggested = Intl.DateTimeFormat().resolvedOptions().timeZone
  async function save(form: HTMLFormElement) {
    const value = new FormData(form).get('timezone')
    if (typeof value !== 'string') return
    setPending(true)
    try {
      onSaved(
        decodeSettings(
          await request('/api/routines/settings', {
            method: 'PUT',
            headers: csrf,
            body: { ...settings, timezone: value },
          }),
        ),
      )
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void save(event.currentTarget)
      }}
    >
      <Field>
        <FieldLabel htmlFor="account-routine-zone">Default routine timezone (browser suggests {suggested})</FieldLabel>
        <Input
          id="account-routine-zone"
          name="timezone"
          defaultValue={settings.timezone === 'UTC' ? suggested : settings.timezone}
          required
        />
      </Field>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="sm" variant="outline" disabled={pending}>
        Save timezone
      </Button>
    </form>
  )
}

function RoutineDetails({ routine }: { readonly routine: RoutineView }) {
  const definition = routine.definition
  const trigger = definition.trigger
  return (
    <>
      <p className="whitespace-pre-wrap text-sm">{definition.prompt}</p>
      <p className="text-sm text-muted-foreground">
        {trigger.kind === 'cron'
          ? `Cron: ${trigger.expression}`
          : trigger.kind === 'once'
            ? `Reminder: ${trigger.at}`
            : `${trigger.serverId} · ${trigger.name}`}{' '}
        · {definition.timezone}
      </p>
      <p className="text-sm">Next: {localTime(routine.nextFireAt, definition.timezone)}</p>
      <p className="text-sm text-muted-foreground">
        {definition.budget.tokensPerRun.toLocaleString()} tokens/run · {definition.budget.tokensPerDay.toLocaleString()}{' '}
        tokens/day · {definition.budget.runtimeSeconds}s maximum
      </p>
      <p className="text-sm">
        Tools:{' '}
        {definition.allowedTools.length === 0
          ? 'None'
          : definition.allowedTools.map((tool) => `${tool.serverId} · ${tool.name}`).join(', ')}
        . Telegram notification: {definition.notifyTelegram ? 'On' : 'Off'}.
      </p>
      {routine.health && (
        <p className="text-sm text-muted-foreground">
          {routine.health === 'execution_pending'
            ? 'Confirmed. Execution is being prepared; this routine has not been armed.'
            : routine.health}
        </p>
      )}
    </>
  )
}

export function RoutineReview({
  routine,
  onChange,
  onEdit,
}: {
  readonly routine: RoutineView
  readonly onChange: (routine: RoutineView) => void
  readonly onEdit?: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function change(action: 'confirm' | 'pause' | 'archive') {
    setPending(true)
    try {
      const path = `/api/routines/${routine.id}${action === 'archive' ? '' : `/${action}`}`
      onChange(
        decodeView(
          await request(path, {
            method: action === 'archive' ? 'DELETE' : 'POST',
            headers: csrf,
            body: { revision: routine.revision, operationId: operation() },
          }),
        ),
      )
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  const definition = routine.definition
  return (
    <Card>
      <CardHeader>
        <CardTitle>{definition.title}</CardTitle>
        <CardDescription>
          Revision {routine.revision} · <Badge variant="outline">{routine.state}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <RoutineDetails routine={routine} />
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {(routine.state === 'proposed' || routine.state === 'paused') && (
              <Button size="sm" disabled={pending} onClick={() => void change('confirm')}>
                Confirm revision {routine.revision}
              </Button>
            )}
            {(routine.state === 'active' || routine.state === 'activating') && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => void change('pause')}>
                Pause
              </Button>
            )}
            {onEdit && (
              <Button size="sm" variant="outline" disabled={pending} onClick={onEdit}>
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => void change('archive')}>
              Archive
            </Button>
          </div>
          <RoutineHistory id={routine.id} revision={routine.revision} active={routine.state === 'active'} />
        </div>
      </CardContent>
    </Card>
  )
}

/** Owner review is an authenticated revisioned API operation, never a model tool confirmation. */
export function RoutinesCard() {
  const [routines, setRoutines] = useState<readonly RoutineView[]>([])
  const [settings, setSettings] = useState<RoutineSettings>()
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<RoutineView>()
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
    setRoutines((current) =>
      [routine, ...current.filter((item) => item.id !== routine.id)].filter((item) => item.state !== 'archived'),
    )
  return (
    <section className="flex flex-col gap-4" aria-label="Routines">
      <div>
        <h2 className="font-medium">Routines</h2>
        <p className="text-sm text-muted-foreground">
          Up to {settings?.maxActive ?? 20} active · {settings?.maxRunning ?? 2} running · account timezone{' '}
          {settings?.timezone ?? 'UTC'}
        </p>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {settings && <RoutineTimezone settings={settings} onSaved={setSettings} />}
      {routines.map((routine) => (
        <RoutineReview key={routine.id} routine={routine} onChange={changed} onEdit={() => setEditing(routine)} />
      ))}
      <RoutineEditor
        key={editing?.id ?? 'new'}
        timezone={settings?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone}
        {...(editing ? { routine: editing, onCancel: () => setEditing(undefined) } : {})}
        onSaved={(routine) => {
          changed(routine)
          setEditing(undefined)
        }}
      />
    </section>
  )
}
