import { type SubmitEvent, useState } from 'react'
import { useMutation, useSuspenseQueries } from '@tanstack/react-query'
import type { RoutineSettings, RoutineView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
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
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { routineSettingsMutation, routineSettingsQuery, routinesQuery } from '../routines/queries.ts'
import { PageSection } from './page-section.tsx'
import { RoutineEditor } from './routine-editor.tsx'
import { RoutineReview } from './routine-review.tsx'
import { browserZone } from '../lib/format.ts'

/** The account's routine timezone: a line saying it, opening to a field to change it. */
function RoutineTimezone({ settings }: { readonly settings: RoutineSettings }) {
  const [open, setOpen] = useState(false)
  const update = useMutation(routineSettingsMutation)
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

/** The owner's routines, newest change first, with the timezone new ones use; both read together. */
function Routines() {
  const [{ data: list }, { data: settings }] = useSuspenseQueries({ queries: [routinesQuery, routineSettingsQuery] })
  const [editing, setEditing] = useState<RoutineView | 'new'>()
  const listed = list.routines
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
      note={`Up to ${settings.maxActive} on at once, ${settings.maxRunning} running at a time.`}
    >
      {listed.length === 0 && editing === undefined && <NoRoutines onNew={() => setEditing('new')} />}
      {editing !== undefined && (
        <RoutineEditor
          key={editing === 'new' ? 'new' : editing.id}
          timezone={settings.timezone === 'UTC' ? browserZone() : settings.timezone}
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
      <RoutineTimezone settings={settings} />
    </PageSection>
  )
}

export function RoutinesSection() {
  return (
    <QueryBoundary
      action="list your routines"
      pending={
        <PageSection id="routines" title="Routines">
          <Skeleton className="h-28 w-full" />
        </PageSection>
      }
    >
      <Routines />
    </QueryBoundary>
  )
}
