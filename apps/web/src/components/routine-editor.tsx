// Writing a routine: what it does, when it runs, and what it may use. Saving makes a proposal the owner then confirms
// on its card; nothing here turns a routine on.
import { type SubmitEvent, useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  PERSONAL_TOPIC,
  type RoutineDefinition,
  type RoutineHandOver,
  type RoutineView,
  handOverOf,
} from '@goblin/contracts'
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
  Textarea,
} from '@goblin/ui'
import { grantsQuery } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { saveRoutineMutation } from '../routines/queries.ts'
import { EditorPart } from './editor-part.tsx'
import { type Kind, WhenFields, triggerFrom } from './routine-when.tsx'

type Tool = { readonly connectionId: string; readonly name: string }

/** A hand-over as the editor starts it: nothing to do yet, no tools, the usual limits. */
const GOBLIN: RoutineHandOver = {
  kind: 'goblin',
  instruction: '',
  allowedTools: [],
  budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
}

const defaults = (timezone: string): RoutineDefinition => ({
  title: '',
  timezone,
  trigger: { kind: 'once', at: '' },
  tellMe: { on: false, telegram: false },
  handTo: GOBLIN,
})

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

const same = (a: Tool, b: Tool): boolean => a.connectionId === b.connectionId && a.name === b.name

function useRoutineEditor({ timezone, routine, onSaved }: EditorProps) {
  const id = useId()
  const initial = routine?.definition ?? defaults(timezone)
  const handOver = handOverOf(initial) ?? GOBLIN
  const [kind, setKind] = useState<Kind>(initial.trigger.kind)
  const [cron, setCron] = useState(initial.trigger.kind === 'cron' ? initial.trigger.expression : '')
  const [selected, setSelected] = useState<readonly Tool[]>(handOver.allowedTools)
  const [notify, setNotify] = useState(initial.tellMe.telegram)
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
      timezone: field('timezone'),
      trigger,
      tellMe: { on: notify, telegram: notify },
      handTo: {
        ...(initial.handTo.kind === 'persona'
          ? { kind: 'persona', persona: initial.handTo.persona, revision: initial.handTo.revision }
          : { kind: 'goblin' }),
        instruction: field('prompt'),
        allowedTools: selected,
        budget: {
          tokensPerRun: Number(field('tokensPerRun')),
          tokensPerDay: Number(field('tokensPerDay')),
          runtimeSeconds: Number(field('runtimeMinutes')) * 60,
        },
      },
    }
    const topic = routine?.topic ?? PERSONAL_TOPIC
    saving.mutate(
      { operationId: crypto.randomUUID(), topic, definition, ...(routine && { routine }) },
      { onSuccess: onSaved },
    )
  }
  const toggle = (tool: Tool, on: boolean) =>
    setSelected((current) => (on ? [...current, tool] : current.filter((item) => !same(item, tool))))
  return {
    id,
    initial,
    handOver,
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

function WhatFields({ kit }: { readonly kit: Kit }) {
  const { id, initial, handOver } = kit
  return (
    <EditorPart title="What">
      <Field>
        <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
        <Input id={`${id}-title`} name="title" defaultValue={initial.title} maxLength={120} required />
      </Field>
      <Field>
        <FieldLabel htmlFor={`${id}-prompt`}>Instructions</FieldLabel>
        <Textarea id={`${id}-prompt`} name="prompt" defaultValue={handOver.instruction} maxLength={12_000} required />
        <FieldDescription>What your agent should do each time, in your own words.</FieldDescription>
      </Field>
    </EditorPart>
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
        const label = `${id}-${tool.connectionId}-${tool.name}`
        return (
          <li key={`${tool.connectionId}:${tool.name}`} className="setting-row">
            <span className="grant-text">
              <span id={label} className="grant-name">
                {tool.name} <code>{tool.connectionId}</code>
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
  const { id, handOver } = kit
  const value = (name: (typeof LIMITS)[number]['name']) =>
    name === 'runtimeMinutes' ? Math.max(1, Math.round(handOver.budget.runtimeSeconds / 60)) : handOver.budget[name]
  return (
    <EditorPart title="Tools and limits">
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
    </EditorPart>
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
