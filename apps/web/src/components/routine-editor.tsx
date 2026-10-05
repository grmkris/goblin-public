import { useEffect, useId, useState } from 'react'
import { Schema } from 'effect'
import { RoutineView, type RoutineDefinition } from '@purrable/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  FieldLabel,
  Input,
  Switch,
  Textarea,
} from '@purrable/ui'
import { failureText, request } from '../lib/boundary.ts'

const Grants = Schema.Array(Schema.Struct({ serverId: Schema.String, capability: Schema.String, name: Schema.String }))
const decodeView = Schema.decodeUnknownSync(RoutineView)
const defaults = (timezone: string): RoutineDefinition => ({
  title: '',
  prompt: '',
  timezone,
  trigger: { kind: 'once', at: '' },
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
})

type EditorProps = {
  readonly timezone: string
  readonly routine?: RoutineView
  readonly onSaved: (routine: RoutineView) => void
  readonly onCancel?: () => void
}
function useRoutineEditor({ timezone, routine, onSaved }: EditorProps) {
  const id = useId()
  const initial = routine?.definition ?? defaults(timezone)
  const [kind, setKind] = useState<'once' | 'cron'>(initial.trigger.kind === 'cron' ? 'cron' : 'once')
  const [tools, setTools] = useState<readonly { serverId: string; name: string }[]>([])
  const [selected, setSelected] = useState(initial.allowedTools)
  const [notify, setNotify] = useState(initial.notifyTelegram)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void request('/api/mcp/grants')
      .then((value) => {
        setTools(Schema.decodeUnknownSync(Grants)(value).filter((grant) => grant.capability === 'tool'))
      })
      .catch((cause: unknown) => setError(failureText(cause)))
  }, [])
  async function save(form: HTMLFormElement) {
    const data = new FormData(form)
    const field = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    const definition: RoutineDefinition = {
      title: field('title'),
      prompt: field('prompt'),
      timezone: field('timezone'),
      trigger:
        kind === 'cron' ? { kind: 'cron', expression: field('trigger') } : { kind: 'once', at: field('trigger') },
      notifyTelegram: notify,
      allowedTools: selected,
      budget: {
        tokensPerRun: Number(field('tokensPerRun')),
        tokensPerDay: Number(field('tokensPerDay')),
        runtimeSeconds: Number(field('runtimeSeconds')),
      },
    }
    setPending(true)
    setError('')
    try {
      const body = { definition, operationId: crypto.randomUUID(), ...(routine ? { revision: routine.revision } : {}) }
      onSaved(
        decodeView(
          await request(routine ? `/api/routines/${routine.id}` : '/api/routines', {
            method: routine ? 'PATCH' : 'POST',
            headers: { 'x-purrable-csrf': '1' },
            body,
          }),
        ),
      )
    } catch (cause) {
      setError(failureText(cause))
    } finally {
      setPending(false)
    }
  }
  const available = [
    ...tools,
    ...selected.filter((tool) => !tools.some((item) => item.serverId === tool.serverId && item.name === tool.name)),
  ]
  return { id, initial, kind, setKind, available, selected, setSelected, notify, setNotify, pending, error, save }
}
type Kit = ReturnType<typeof useRoutineEditor>
function triggerValue(initial: RoutineDefinition, kind: 'once' | 'cron') {
  if (initial.trigger.kind !== kind) return ''
  if (initial.trigger.kind === 'cron') return initial.trigger.expression
  return initial.trigger.kind === 'once' ? initial.trigger.at : ''
}
function DefinitionFields({ kit }: { readonly kit: Kit }) {
  const { id, initial, kind, setKind } = kit
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
        <Input id={`${id}-title`} name="title" defaultValue={initial.title} maxLength={120} required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-prompt`}>Instructions</FieldLabel>
        <Textarea id={`${id}-prompt`} name="prompt" defaultValue={initial.prompt} maxLength={12_000} required />
      </Field>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant={kind === 'once' ? 'secondary' : 'outline'}
          onClick={() => setKind('once')}
        >
          Reminder
        </Button>
        <Button
          type="button"
          size="sm"
          variant={kind === 'cron' ? 'secondary' : 'outline'}
          onClick={() => setKind('cron')}
        >
          Cron schedule
        </Button>
      </div>
      <Field>
        <FieldLabel htmlFor={`${id}-trigger`}>
          {kind === 'cron' ? 'Five-field cron (at least 15 minutes apart)' : 'Date and time with UTC offset'}
        </FieldLabel>
        <Input
          key={kind}
          id={`${id}-trigger`}
          name="trigger"
          required
          defaultValue={triggerValue(initial, kind)}
          placeholder={kind === 'cron' ? '0 9 * * 1-5' : '2026-10-06T09:00:00+02:00'}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-timezone`}>Timezone</FieldLabel>
        <Input id={`${id}-timezone`} name="timezone" defaultValue={initial.timezone} required />
      </Field>
    </>
  )
}
function ToolFields({ kit }: { readonly kit: Kit }) {
  const { available, selected, setSelected, notify, setNotify } = kit
  return (
    <>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Exact connected tools</legend>
        {available.length === 0 && (
          <p className="text-sm text-muted-foreground">No granted tools. This routine can only produce an answer.</p>
        )}
        {available.map((tool) => {
          const checked = selected.some((item) => item.serverId === tool.serverId && item.name === tool.name)
          return (
            <label key={`${tool.serverId}:${tool.name}`} className="flex items-center gap-2 text-sm">
              <Switch
                checked={checked}
                onCheckedChange={(on) =>
                  setSelected((current) =>
                    on
                      ? [...current, tool]
                      : current.filter((item) => item.serverId !== tool.serverId || item.name !== tool.name),
                  )
                }
              />
              {tool.serverId} · {tool.name}
            </label>
          )
        })}
      </fieldset>
      <label className="flex items-center gap-2 text-sm">
        <Switch checked={notify} onCheckedChange={setNotify} />
        Send the short report through my Telegram channel
      </label>
    </>
  )
}
function BudgetFields({ kit }: { readonly kit: Kit }) {
  const { id, initial } = kit
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        {(['tokensPerRun', 'tokensPerDay', 'runtimeSeconds'] as const).map((name) => (
          <Field key={name}>
            <FieldLabel htmlFor={`${id}-${name}`}>
              {name === 'tokensPerRun'
                ? 'Tokens per run'
                : name === 'tokensPerDay'
                  ? 'Tokens per day'
                  : 'Maximum seconds'}
            </FieldLabel>
            <Input
              id={`${id}-${name}`}
              name={name}
              type="number"
              min={1}
              max={name === 'runtimeSeconds' ? 1800 : name === 'tokensPerRun' ? 100_000 : 2_000_000}
              defaultValue={initial.budget[name]}
              required
            />
          </Field>
        ))}
      </div>
    </>
  )
}
/** Saving creates a proposed revision; the separate review is the only activation control. */
export function RoutineEditor(props: EditorProps) {
  const kit = useRoutineEditor(props)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.routine ? `Edit ${props.routine.definition.title}` : 'New routine'}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void kit.save(event.currentTarget)
          }}
        >
          <DefinitionFields kit={kit} />
          <ToolFields kit={kit} />
          <BudgetFields kit={kit} />
          <p className="text-sm text-muted-foreground">
            Saving pauses future triggers until you review and confirm this revision.
          </p>
          {kit.error && (
            <Alert variant="destructive">
              <AlertDescription>{kit.error}</AlertDescription>
            </Alert>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={kit.pending}>
              {kit.pending ? 'Saving…' : 'Save proposal'}
            </Button>
            {props.onCancel && (
              <Button type="button" variant="ghost" onClick={props.onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
