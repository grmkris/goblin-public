// Writing a routine: what it does, when it runs, and what it may use. Saving makes a proposal the owner then confirms
// on its card; nothing here turns a routine on.
import { type SubmitEvent, type ReactNode, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Option, Schema } from 'effect'
import type { RoutineDefinition, RoutineView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldDescription,
  FieldLabel,
  Input,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@goblin/ui'
import { grantsQuery } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { saveRoutineMutation } from '../routines/queries.ts'
import { localInput, localInstant } from '../lib/local-time.ts'
import { browserZone } from '../lib/format.ts'

type Kind = RoutineDefinition['trigger']['kind']
type Tool = { readonly serverId: string; readonly name: string }

const defaults = (timezone: string): RoutineDefinition => ({
  title: '',
  prompt: '',
  timezone,
  trigger: { kind: 'once', at: '' },
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
})

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
function triggerFrom(
  kind: Kind,
  field: (name: string) => string,
  cron: string,
): RoutineDefinition['trigger'] | TriggerProblem {
  if (kind === 'cron') return { kind: 'cron', expression: cron }
  if (kind === 'event') {
    const filters = field('eventArguments').trim()
    const parsed = filters === '' ? Option.some({}) : decodeFilters(filters)
    if (Option.isNone(parsed)) return { problem: 'Write the filters as a JSON object, or leave them empty.' }
    return { kind: 'event', serverId: field('eventServer'), name: field('eventName'), arguments: parsed.value }
  }
  const at = localInstant(field('at'))
  if (at === undefined) return { problem: 'Pick the date and time it should run.' }
  return { kind: 'once', at }
}

type EditorProps = {
  readonly timezone: string
  readonly routine?: RoutineView
  readonly onSaved: (routine: RoutineView) => void
  readonly onCancel?: () => void
}

/**
 * The tools the owner has allowed, plus any the routine already names, so editing never drops one silently; and why
 * the allowed ones could not be read, if they could not.
 */
function useAvailableTools(selected: readonly Tool[]) {
  const read = useQuery(grantsQuery)
  const tools = (read.data ?? []).filter((grant) => grant.capability === 'tool')
  return {
    available: [...tools, ...selected.filter((tool) => !tools.some((item) => same(item, tool)))],
    unread: read.error === null ? '' : messageOf(read.error, 'list the tools you allowed'),
  }
}

const same = (a: Tool, b: Tool): boolean => a.serverId === b.serverId && a.name === b.name

function useRoutineEditor({ timezone, routine, onSaved }: EditorProps) {
  const id = useId()
  const initial = routine?.definition ?? defaults(timezone)
  const [kind, setKind] = useState<Kind>(initial.trigger.kind)
  const [cron, setCron] = useState(initial.trigger.kind === 'cron' ? initial.trigger.expression : '')
  const [selected, setSelected] = useState<readonly Tool[]>(initial.allowedTools)
  const [notify, setNotify] = useState(initial.notifyTelegram)
  const saving = useMutation(saveRoutineMutation)
  const [problem, setProblem] = useState('')
  const { available, unread } = useAvailableTools(selected)
  const pending = saving.isPending
  const error = problem || (saving.error === null ? '' : messageOf(saving.error, 'save the routine')) || unread
  function save(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    setProblem('')
    saving.reset()
    const trigger = triggerFrom(kind, field, cron)
    if ('problem' in trigger) {
      setProblem(trigger.problem)
      return
    }
    const definition: RoutineDefinition = {
      title: field('title'),
      prompt: field('prompt'),
      timezone: field('timezone'),
      trigger,
      notifyTelegram: notify,
      allowedTools: selected,
      budget: {
        tokensPerRun: Number(field('tokensPerRun')),
        tokensPerDay: Number(field('tokensPerDay')),
        runtimeSeconds: Number(field('runtimeMinutes')) * 60,
      },
    }
    saving.mutate({ operationId: crypto.randomUUID(), definition, ...(routine && { routine }) }, { onSuccess: onSaved })
  }
  const toggle = (tool: Tool, on: boolean) =>
    setSelected((current) => (on ? [...current, tool] : current.filter((item) => !same(item, tool))))
  return {
    id,
    initial,
    kind,
    setKind,
    cron,
    setCron,
    available,
    selected,
    toggle,
    notify,
    setNotify,
    pending,
    error,
    save,
  }
}
type Kit = ReturnType<typeof useRoutineEditor>

/** One part of the form under a small heading. */
function Part({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId()
  return (
    <section className="editor-part" aria-labelledby={id}>
      <h3 id={id} className="server-part-title">
        {title}
      </h3>
      {children}
    </section>
  )
}

function WhatFields({ kit }: { readonly kit: Kit }) {
  const { id, initial } = kit
  return (
    <Part title="What">
      <Field>
        <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
        <Input id={`${id}-title`} name="title" defaultValue={initial.title} maxLength={120} required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-prompt`}>Instructions</FieldLabel>
        <Textarea id={`${id}-prompt`} name="prompt" defaultValue={initial.prompt} maxLength={12_000} required />
        <FieldDescription>What your agent should do each time, in your own words.</FieldDescription>
      </Field>
    </Part>
  )
}

function OnceFields({ kit }: { readonly kit: Kit }) {
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

function CronFields({ kit }: { readonly kit: Kit }) {
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

function EventFields({ kit }: { readonly kit: Kit }) {
  const trigger = kit.initial.trigger
  const servers = [...new Set(kit.available.map((tool) => tool.serverId))]
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${kit.id}-event-server`}>Server</FieldLabel>
        <Input
          id={`${kit.id}-event-server`}
          name="eventServer"
          list={`${kit.id}-servers`}
          defaultValue={trigger.kind === 'event' ? trigger.serverId : (servers[0] ?? '')}
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

function WhenFields({ kit }: { readonly kit: Kit }) {
  const { id, initial } = kit
  return (
    <Part title="When">
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
    </Part>
  )
}

function ToolRows({ kit }: { readonly kit: Kit }) {
  const { available, selected, toggle, notify, setNotify, id } = kit
  return (
    <ul className="grant-list">
      {available.length === 0 && (
        <li className="setting-row">
          <span className="server-note">You have allowed no tools yet, so this routine can only answer.</span>
        </li>
      )}
      {available.map((tool) => {
        const label = `${id}-${tool.serverId}-${tool.name}`
        return (
          <li key={`${tool.serverId}:${tool.name}`} className="setting-row">
            <span className="grant-text">
              <span id={label} className="grant-name">
                {tool.name} <code>{tool.serverId}</code>
              </span>
            </span>
            <Switch
              checked={selected.some((item) => same(item, tool))}
              aria-labelledby={label}
              onCheckedChange={(on) => toggle(tool, on)}
            />
          </li>
        )
      })}
      <li className="setting-row">
        <span className="grant-text">
          <span id={`${id}-telegram`} className="grant-name">
            Send its report to Telegram too
          </span>
          <span className="grant-about">Through the server you use for Telegram, if you have one.</span>
        </span>
        <Switch checked={notify} aria-labelledby={`${id}-telegram`} onCheckedChange={setNotify} />
      </li>
    </ul>
  )
}

const LIMITS = [
  { name: 'tokensPerRun', label: 'Tokens a run', max: 100_000 },
  { name: 'tokensPerDay', label: 'Tokens a day', max: 2_000_000 },
  { name: 'runtimeMinutes', label: 'Minutes at most', max: 30 },
] as const

function ToolsAndLimits({ kit }: { readonly kit: Kit }) {
  const { id, initial } = kit
  const value = (name: (typeof LIMITS)[number]['name']) =>
    name === 'runtimeMinutes' ? Math.max(1, Math.round(initial.budget.runtimeSeconds / 60)) : initial.budget[name]
  return (
    <Part title="Tools and limits">
      <ToolRows kit={kit} />
      <div className="editor-limits">
        {LIMITS.map((limit) => (
          <Field key={limit.name}>
            <FieldLabel htmlFor={`${id}-${limit.name}`}>{limit.label}</FieldLabel>
            <Input
              id={`${id}-${limit.name}`}
              name={limit.name}
              type="number"
              inputMode="numeric"
              min={1}
              max={limit.max}
              defaultValue={value(limit.name)}
              required
            />
          </Field>
        ))}
      </div>
    </Part>
  )
}

/** Saving creates a proposed revision; the separate review is the only activation control. */
export function RoutineEditor(props: EditorProps) {
  const kit = useRoutineEditor(props)
  return (
    <Card>
      <CardHeader>
        <CardTitle>{props.routine ? `Edit “${props.routine.definition.title}”` : 'New routine'}</CardTitle>
        <CardDescription>
          {props.routine
            ? 'Saving pauses it until you confirm the change on its card.'
            : 'Saving makes a proposal: nothing runs until you confirm it on its card.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="editor" onSubmit={kit.save}>
          <WhatFields kit={kit} />
          <WhenFields kit={kit} />
          <ToolsAndLimits kit={kit} />
          {kit.error && (
            <Alert variant="destructive">
              <AlertDescription>{kit.error}</AlertDescription>
            </Alert>
          )}
          <div className="card-actions">
            <Button type="submit" pending={kit.pending}>
              Save for review
            </Button>
            {props.onCancel && (
              <Button type="button" variant="ghost" disabled={kit.pending} onClick={props.onCancel}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  )
}
