// Picking a connection's events (ADR 0041, amended 2026-10-12): each event the server offers in its group, with its
// own words, the ones the server recommends picked already, where each goes (a Topic, or a hand-over to goblin or a
// Persona on Pro), Advanced for filters, an instruction and Tell me, and one action that sets them all up.
import { useId, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { EventStream, PersonaView, ServerView, TopicView } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Field,
  FieldDescription,
  FieldLabel,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
} from '@goblin/ui'
import { ChevronRightIcon, PlugIcon } from 'lucide-react'
import { useBilling } from '../account/hooks.ts'
import {
  type EventChoice,
  type EventRoute,
  choiceFor,
  defaultInstruction,
  handsOver,
  routeKey,
  routeOf,
  setUpOf,
  suggestedRoute,
  TELL_MAIN,
} from '../lib/event-setup.ts'
import { RATE_WORDS, eventGroups, eventSummary, eventTitle } from '../lib/events.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { usePersonas, useTopics } from '../lib/workspace/hooks.ts'
import { routineSettingsQuery, setUpEventsMutation } from '../routines/queries.ts'
import { ProNote, hasHandOver } from './pro-note.tsx'
import { SchemaForm } from './schema-form.tsx'

type Choices = ReadonlyMap<string, EventChoice>

/** What the picker offers a route to: the live Topics and Personas, and whether the owner may hand over (Pro). */
type Places = {
  readonly topics: readonly TopicView[]
  readonly personas: readonly PersonaView[]
  readonly handOver: boolean
}

/** Where routes go, and whether the plan hands over (Pro): the owner's live Topics and Personas. */
function usePlaces(): Places {
  const { state } = useBilling()
  const topics = useTopics().filter((topic) => topic.archivedAt === undefined)
  const personas = usePersonas().filter((persona) => persona.archivedAt === undefined)
  return { topics, personas, handOver: hasHandOver(state) }
}

/** A route in words, for a picked event's line: where it is told, or who acts on it and where. */
function routeWords(route: EventRoute, places: Places): string {
  if (route.kind === 'persona') {
    const name = places.personas.find((persona) => persona.id === route.persona)?.name ?? 'Persona'
    return `@${name} acts on it`
  }
  const topic = `#${places.topics.find((each) => each.id === route.topic)?.name ?? 'Personal'}`
  return route.kind === 'tell' ? `Tell me in ${topic}` : `goblin acts on it in ${topic}`
}

/** Who answers a hand-over the owner is not told of, and where the answer waits. */
function answerWords(route: EventRoute, places: Places): string {
  if (route.kind === 'persona') return `${routeWords(route, places)} and answers in #Personal.`
  const topic = places.topics.find((each) => each.id === route.topic)?.name ?? 'Personal'
  return `goblin acts on it and answers in #${topic}.`
}

/**
 * Where one picked event goes, as one compact select: Tell me in a Topic, or (Pro) goblin acting on it in a Topic or a
 * Persona acting on it. On the free plan the hand-overs show, but cannot be picked.
 */
function RouteSelect({
  title,
  route,
  places,
  onRoute,
}: {
  readonly title: string
  readonly route: EventRoute
  readonly places: Places
  readonly onRoute: (route: EventRoute) => void
}) {
  const option = (each: EventRoute, disabled = false) => (
    <NativeSelectOption key={routeKey(each)} value={routeKey(each)} disabled={disabled}>
      {routeWords(each, places)}
    </NativeSelectOption>
  )
  return (
    <span className="event-route">
      <NativeSelect
        size="sm"
        aria-label={`Where “${title}” goes`}
        value={routeKey(route)}
        onChange={(change) => {
          const picked = routeOf(change.target.value)
          if (picked !== undefined) onRoute(picked)
        }}
      >
        <optgroup label="Tell me">{places.topics.map((topic) => option({ kind: 'tell', topic: topic.id }))}</optgroup>
        <optgroup label={places.handOver ? 'Hand it over' : 'Hand it over (Pro)'}>
          {places.topics.map((topic) => option({ kind: 'goblin', topic: topic.id }, !places.handOver))}
          {places.personas.map((persona) => option({ kind: 'persona', persona: persona.id }, !places.handOver))}
        </optgroup>
      </NativeSelect>
    </span>
  )
}

/**
 * What a picked event will do, in a line: the notice the owner will see, from the server's own words for the event, or
 * who answers where when it only hands over.
 */
function Preview({
  stream,
  choice,
  places,
}: {
  readonly stream: EventStream
  readonly choice: EventChoice
  readonly places: Places
}) {
  const summary = eventSummary(stream)
  if (choice.route.kind !== 'tell' && !choice.tellMe)
    return <p className="event-preview">{answerWords(choice.route, places)}</p>
  return (
    <p className="event-preview">
      <PlugIcon aria-hidden />
      <span>
        You’ll see: <span className="event-preview-title">{eventTitle(stream)}</span>
        {summary !== undefined && ` · ${summary}`}
      </span>
    </p>
  )
}

/** One event the owner can pick: its title, its line, how often it comes, and, once picked, where it goes. */
function PickRow({
  stream,
  choice,
  places,
  onPick,
  onRoute,
}: {
  readonly stream: EventStream
  readonly choice: EventChoice | undefined
  readonly places: Places
  readonly onPick: (picked: boolean) => void
  readonly onRoute: (route: EventRoute) => void
}) {
  const title = eventTitle(stream)
  const summary = eventSummary(stream)
  return (
    <li className="event-pick" data-picked={choice !== undefined}>
      <div className="event-pick-head">
        <label className="event-pick-label">
          <input type="checkbox" checked={choice !== undefined} onChange={(event) => onPick(event.target.checked)} />
          <span className="event-pick-text">
            <span className="event-pick-title">
              {title}
              {stream.rate !== undefined && <span className="event-rate">{RATE_WORDS[stream.rate]}</span>}
            </span>
            {summary !== undefined && <span className="event-pick-about">{summary}</span>}
          </span>
        </label>
        {choice !== undefined && <RouteSelect title={title} route={choice.route} places={places} onRoute={onRoute} />}
      </div>
      {choice !== undefined && <Preview stream={stream} choice={choice} places={places} />}
    </li>
  )
}

/** An event the Telegram channel already brings in: named, with why it is not offered again. */
function TelegramRow({ stream }: { readonly stream: EventStream }) {
  return (
    <li className="event-pick" data-static>
      <span className="event-pick-text">
        <span className="event-pick-title">{eventTitle(stream)}</span>
        <span className="event-pick-about">Already arrives through Telegram.</span>
      </span>
    </li>
  )
}

/** One switch row of Advanced: its words, and the switch they name. */
function SwitchRow({
  id,
  name,
  about,
  checked,
  disabled,
  onChange,
}: {
  readonly id: string
  readonly name: string
  readonly about: string
  readonly checked: boolean
  readonly disabled: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <li className="setting-row">
      <span className="grant-text">
        <span id={id} className="grant-name">
          {name}
        </span>
        <span className="grant-about">{about}</span>
      </span>
      <Switch checked={checked} disabled={disabled} aria-labelledby={id} onCheckedChange={onChange} />
    </li>
  )
}

/** Advanced for one picked event: its filters from the server's schema, the handler's instruction, Tell me. */
function AdvancedFor({
  server,
  stream,
  choice,
  onChange,
}: {
  readonly server: ServerView
  readonly stream: EventStream
  readonly choice: EventChoice
  readonly onChange: (patch: Partial<EventChoice>) => void
}) {
  const id = useId()
  const told = choice.route.kind === 'tell' || choice.tellMe
  return (
    <fieldset className="event-advanced">
      <legend className="event-advanced-title">{eventTitle(stream)}</legend>
      <SchemaForm
        id={`${id}-filters`}
        schema={stream.inputSchema}
        initial={'value' in choice.filters ? choice.filters.value : {}}
        onChange={(filters) => onChange({ filters })}
      />
      {handsOver(choice.route) && (
        <Field>
          <FieldLabel htmlFor={`${id}-instruction`}>Instructions (optional)</FieldLabel>
          <Textarea
            id={`${id}-instruction`}
            value={choice.instruction}
            placeholder={defaultInstruction(stream, server)}
            maxLength={12_000}
            onChange={(event) => onChange({ instruction: event.target.value })}
          />
          <FieldDescription>
            What to do with each one. It can only answer until you give it tools in Edit.
          </FieldDescription>
        </Field>
      )}
      <ul className="grant-list">
        <SwitchRow
          id={`${id}-tell-me`}
          name="Tell me"
          about={
            choice.route.kind === 'tell'
              ? 'Always on when it goes to a Topic.'
              : 'A notice when it comes, then the answer, in Activity.'
          }
          checked={told}
          disabled={choice.route.kind === 'tell'}
          onChange={(on) => onChange({ tellMe: on, ...(on ? {} : { telegram: false }) })}
        />
        <SwitchRow
          id={`${id}-telegram`}
          name="On Telegram too"
          about="Through the connection you use for Telegram, if you have one."
          checked={told && choice.telegram}
          disabled={!told}
          onChange={(on) => onChange({ telegram: on })}
        />
      </ul>
    </fieldset>
  )
}

/**
 * The picker's state: the events that can be picked (subscribable, not set up yet, not already through Telegram), the
 * picks (the server's recommendations until the owner changes one, while the offer is open), and one step that sets
 * them all up.
 */
function useEventPicks(server: ServerView, available: readonly EventStream[], places: Places) {
  const [touched, setTouched] = useState<Choices>()
  const [problem, setProblem] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const timezone = useQuery(routineSettingsQuery).data?.timezone ?? 'UTC'
  const setting = useMutation(setUpEventsMutation)
  const suggested = new Map<string, EventChoice>()
  if (touched === undefined && server.events === 'open')
    for (const stream of available) {
      const route = suggestedRoute(stream, places.handOver)
      if (route !== undefined) suggested.set(stream.name, choiceFor(stream, route))
    }
  const choices: Choices = new Map(
    [...(touched ?? suggested)].filter(([name]) => available.some((stream) => stream.name === name)),
  )
  const change = (next: Choices) => {
    setProblem('')
    setting.reset()
    setTouched(next)
  }
  const pick = (stream: EventStream, picked: boolean) => {
    const next = new Map(choices)
    if (picked) next.set(stream.name, choiceFor(stream, suggestedRoute(stream, places.handOver) ?? TELL_MAIN))
    else next.delete(stream.name)
    change(next)
  }
  const update = (name: string, patch: Partial<EventChoice>) => {
    const current = choices.get(name)
    if (current !== undefined) change(new Map(choices).set(name, { ...current, ...patch }))
  }
  const setUp = () => {
    const made = available.flatMap((stream) => {
      const choice = choices.get(stream.name)
      return choice === undefined ? [] : [setUpOf(stream, server, choice, places.personas, timezone)]
    })
    const wrong = made.find((each) => 'problem' in each)
    if (wrong !== undefined && 'problem' in wrong) {
      setProblem(wrong.problem)
      setAdvanced(true)
      return
    }
    const requests = made.flatMap((each) => ('problem' in each ? [] : [{ ...each, operationId: crypto.randomUUID() }]))
    setting.mutate(requests, { onSuccess: () => setTouched(new Map()) })
  }
  const error = problem || (setting.error === null ? '' : messageOf(setting.error, 'set up these events'))
  return { choices, pick, update, setUp, error, pending: setting.isPending, advanced, setAdvanced }
}

type Picks = ReturnType<typeof useEventPicks>

/** Advanced, folded away: for each picked event, its filters, the handler's instruction and Tell me. */
function AdvancedSection({
  server,
  streams,
  picks,
}: {
  readonly server: ServerView
  readonly streams: readonly EventStream[]
  readonly picks: Picks
}) {
  return (
    <Collapsible open={picks.advanced} onOpenChange={picks.setAdvanced}>
      <CollapsibleTrigger render={<button type="button" className="event-advanced-toggle" />}>
        <ChevronRightIcon aria-hidden />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="event-advanced-list">
          {streams.map((stream) => {
            const choice = picks.choices.get(stream.name)
            return (
              choice !== undefined && (
                <AdvancedFor
                  key={stream.name}
                  server={server}
                  stream={stream}
                  choice={choice}
                  onChange={(patch) => picks.update(stream.name, patch)}
                />
              )
            )
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** The quiet line on what goblin holds itself to (ADR 0012, 0041). */
const LIMITS =
  'At most one run a minute. Past 20 notices an hour, the rest wait in Activity behind one line. Events from before you set one up are dropped.'

/**
 * A connection's events to pick (ADR 0041): grouped as the server groups them, the recommended ones picked already, each
 * routed in one select, Advanced folded away, and Set up for all of them at once. Setting up proposes and confirms
 * each event's own routine, so it grants exactly that event with those filters.
 */
export function EventPicker({
  server,
  streams,
  telegram,
}: {
  readonly server: ServerView
  /** The events that can be set up here: subscribable, with no routine on them yet. */
  readonly streams: readonly EventStream[]
  /** The names of the events the Telegram channel already brings in. */
  readonly telegram: ReadonlySet<string>
}) {
  const places = usePlaces()
  const available = streams.filter((stream) => !telegram.has(stream.name))
  const picks = useEventPicks(server, available, places)
  const groups = eventGroups(streams, server)
  const count = picks.choices.size
  if (streams.length === 0) return null
  return (
    <div className="event-picker">
      {groups.map(({ group, streams: members }) => (
        <div key={group} className="event-group">
          {groups.length > 1 && <h4 className="event-group-title">{group}</h4>}
          <ul className="event-picks">
            {members.map((stream) =>
              telegram.has(stream.name) ? (
                <TelegramRow key={stream.name} stream={stream} />
              ) : (
                <PickRow
                  key={stream.name}
                  stream={stream}
                  choice={picks.choices.get(stream.name)}
                  places={places}
                  onPick={(picked) => picks.pick(stream, picked)}
                  onRoute={(route) => picks.update(stream.name, { route })}
                />
              ),
            )}
          </ul>
        </div>
      ))}
      {!places.handOver && available.length > 0 && (
        <ProNote>Handing an event to goblin or a Persona is part of Pro.</ProNote>
      )}
      {count > 0 && <AdvancedSection server={server} streams={available} picks={picks} />}
      {picks.error !== '' && (
        <Alert variant="destructive">
          <AlertDescription>{picks.error}</AlertDescription>
        </Alert>
      )}
      {available.length > 0 && (
        <div className="event-picker-foot">
          <Button type="button" size="sm" pending={picks.pending} disabled={count === 0} onClick={picks.setUp}>
            {count === 0 ? 'Set up' : `Set up ${String(count)} ${count === 1 ? 'event' : 'events'}`}
          </Button>
          <p className="event-limits">{LIMITS}</p>
        </div>
      )}
    </div>
  )
}
