// Writing a routine (ADR 0041): when it fires, where it lives, whether it tells the owner, and whom it hands the work
// to. Saving makes a proposal the owner then confirms on its card; nothing here turns a routine on.
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
  FieldLabel,
  Input,
} from '@goblin/ui'
import { grantsQuery } from '../mcp/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { saveRoutineMutation } from '../routines/queries.ts'
import { EditorPart } from './editor-part.tsx'
import { type HandKind, HandToFields, TellMeFields, WhereField } from './routine-hand.tsx'
import { type EventChoice, type Kind, WhenFields, eventOf, triggerFrom } from './routine-when.tsx'

type Tool = { readonly connectionId: string; readonly name: string }

/** A hand-over as the editor starts it: nothing to do yet, no tools, the usual limits. */
const GOBLIN: RoutineHandOver = {
  kind: 'goblin',
  instruction: '',
  allowedTools: [],
  budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
}

/** A new routine: a reminder that tells the owner, handed to nobody yet. */
const defaults = (timezone: string): RoutineDefinition => ({
  title: '',
  timezone,
  trigger: { kind: 'once', at: '' },
  tellMe: { on: true, telegram: false },
  handTo: { kind: 'none' },
})

type EditorProps = {
  readonly timezone: string
  readonly routine?: RoutineView
  /** A new routine's start, when it is not a blank one: an event the owner picked on a connection's card. */
  readonly draft?: RoutineDefinition
  /** A new routine's Topic, when not Personal. */
  readonly topic?: number
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

/** Where the routine lives, whether it tells the owner, and whom it hands the work to, as the owner picks them. */
function useHand(initial: RoutineDefinition, startTopic: number) {
  const { handTo } = initial
  const [topic, setTopic] = useState(startTopic)
  const [tellMe, setTellMe] = useState(initial.tellMe.on)
  const [telegram, setTelegram] = useState(initial.tellMe.telegram)
  const [hand, setHand] = useState<HandKind>(handTo.kind)
  const [persona, setPersona] = useState(handTo.kind === 'persona' ? handTo.persona : undefined)
  const handOver = handOverOf(initial) ?? GOBLIN
  const [selected, setSelected] = useState<readonly Tool[]>(handOver.allowedTools)
  const toggle = (tool: Tool, on: boolean) =>
    setSelected((current) => (on ? [...current, tool] : current.filter((item) => !same(item, tool))))
  const topics = useTopics().filter((each) => each.archivedAt === undefined || each.id === topic)
  const personas = usePersonas().filter((each) => each.archivedAt === undefined || each.id === persona)
  return {
    topic,
    setTopic,
    tellMe,
    setTellMe,
    telegram,
    setTelegram,
    hand,
    setHand,
    persona,
    setPersona,
    handOver,
    selected,
    toggle,
    topics,
    personas,
  }
}

type Hand = ReturnType<typeof useHand>

/** The hand-over the form describes, with a Persona pinned at its revision now; or what to fix first. */
function handToFrom(hand: Hand, field: (name: string) => string): RoutineDefinition['handTo'] | { problem: string } {
  if (hand.hand === 'none')
    return hand.tellMe ? { kind: 'none' } : { problem: 'Turn Tell me on, hand it over, or both.' }
  const handOver = {
    instruction: field('prompt'),
    allowedTools: hand.selected,
    budget: {
      tokensPerRun: Number(field('tokensPerRun')),
      tokensPerDay: Number(field('tokensPerDay')),
      runtimeSeconds: Number(field('runtimeMinutes')) * 60,
    },
  }
  if (hand.hand === 'goblin') return { kind: 'goblin', ...handOver }
  const persona = hand.personas.find((each) => each.id === hand.persona)
  if (persona === undefined) return { problem: 'Pick the Persona it hands the work to.' }
  return { kind: 'persona', persona: persona.id, revision: persona.revision, ...handOver }
}

function useRoutineEditor({ timezone, routine, draft, topic, onSaved }: EditorProps) {
  const id = useId()
  const initial = routine?.definition ?? draft ?? defaults(timezone)
  const [kind, setKind] = useState<Kind>(initial.trigger.kind)
  const [cron, setCron] = useState(initial.trigger.kind === 'cron' ? initial.trigger.expression : '')
  const [event, setEvent] = useState<EventChoice>(eventOf(initial))
  const hand = useHand(initial, routine?.topic ?? topic ?? PERSONAL_TOPIC)
  const saving = useMutation(saveRoutineMutation)
  const [problem, setProblem] = useState('')
  const { available, unread } = useAvailableTools(hand.selected)
  const error = problem || (saving.error === null ? '' : messageOf(saving.error, 'save the routine')) || unread
  function save(submit: SubmitEvent<HTMLFormElement>): void {
    submit.preventDefault()
    const data = new FormData(submit.currentTarget)
    const field = (name: string) => {
      const value = data.get(name)
      return typeof value === 'string' ? value : ''
    }
    setProblem('')
    saving.reset()
    const trigger = triggerFrom(kind, field, cron, event)
    if ('problem' in trigger) {
      setProblem(trigger.problem)
      return
    }
    const handTo = handToFrom(hand, field)
    if ('problem' in handTo) {
      setProblem(handTo.problem)
      return
    }
    const definition: RoutineDefinition = {
      title: field('title'),
      timezone: field('timezone'),
      trigger,
      tellMe: { on: hand.tellMe, telegram: hand.tellMe && hand.telegram },
      handTo,
    }
    saving.mutate(
      { operationId: crypto.randomUUID(), topic: hand.topic, definition, ...(routine && { routine }) },
      { onSuccess: onSaved },
    )
  }
  const when = { id, initial, kind, setKind, cron, setCron, event, setEvent }
  return { when, hand: { id, available, ...hand }, pending: saving.isPending, error, save }
}

/** Saving creates a proposed revision; the separate review is the only activation control. */
export function RoutineEditor(props: EditorProps) {
  const kit = useRoutineEditor(props)
  const { id, initial } = kit.when
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
          <EditorPart title="What">
            <Field>
              <FieldLabel htmlFor={`${id}-title`}>Title</FieldLabel>
              <Input id={`${id}-title`} name="title" defaultValue={initial.title} maxLength={120} required />
            </Field>
            <WhereField kit={kit.hand} />
          </EditorPart>
          <WhenFields kit={kit.when} />
          <TellMeFields kit={kit.hand} />
          <HandToFields kit={kit.hand} />
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
