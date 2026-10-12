// Setting up a connection's events in one step (ADR 0041, amended 2026-10-12): where each picked event goes (a Topic,
// where goblin tells the owner, or a hand-over to goblin or a Persona), and the routine that makes. Pure, so the picker
// only draws it.
import {
  PERSONAL_TOPIC,
  type EventStream,
  type PersonaView,
  type RoutineBudget,
  type RoutineDefinition,
  type ServerView,
} from '@goblin/contracts'
import { type FormResult, formFields, formValue } from './schema-form.ts'
import { eventTitle } from './events.ts'

/**
 * Where an event goes: a Topic, where goblin tells the owner (free); goblin acting on it in a Topic, or a Persona (who
 * answers in Personal), both hand-overs and so Pro.
 */
export type EventRoute =
  | { readonly kind: 'tell'; readonly topic: number }
  | { readonly kind: 'goblin'; readonly topic: number }
  | { readonly kind: 'persona'; readonly persona: number }

/** What the owner chose for one picked event: where it goes, its filters, the handler's instruction, and Tell me. */
export type EventChoice = {
  readonly route: EventRoute
  readonly filters: FormResult
  /** The instruction for whoever it is handed to; empty takes the one goblin writes. */
  readonly instruction: string
  /** Tell me for a hand-over (a route to a Topic always tells). */
  readonly tellMe: boolean
  readonly telegram: boolean
}

/** A route as one select value: `tell:1`, `goblin:2`, `persona:7`. */
export const routeKey = (route: EventRoute): string =>
  route.kind === 'persona' ? `persona:${String(route.persona)}` : `${route.kind}:${String(route.topic)}`

/** The route a select value names; none for one it does not. */
export function routeOf(key: string): EventRoute | undefined {
  const [kind, id] = key.split(':')
  const number = Number(id)
  if (!Number.isInteger(number) || number <= 0) return undefined
  if (kind === 'persona') return { kind, persona: number }
  return kind === 'tell' || kind === 'goblin' ? { kind, topic: number } : undefined
}

/** Whether a route hands the event over, which runs the agent (Pro). */
export const handsOver = (route: EventRoute): boolean => route.kind !== 'tell'

/** Tell me in the main conversation (Personal): where an event goes until the owner says otherwise. */
export const TELL_MAIN: EventRoute = { kind: 'tell', topic: PERSONAL_TOPIC }

/**
 * Where a stream goes when the picker opens, from the server's suggestion, or none when it is not picked: a recommended
 * event the server says to tell the owner about goes to Personal; one it recommends without telling (work for the
 * agent) is handed to goblin there on Pro, and left unpicked on the free plan, where telling is all there is. Without
 * a suggestion nothing is picked.
 */
export function suggestedRoute(stream: EventStream, handOver: boolean): EventRoute | undefined {
  if (stream.recommended !== true) return undefined
  if (stream.tellMe === true) return TELL_MAIN
  return handOver ? { kind: 'goblin', topic: PERSONAL_TOPIC } : undefined
}

/** The filters a fresh choice starts with: none, or what to fix first when the server's schema requires one. */
const startingFilters = (stream: EventStream): FormResult => {
  const fields = formFields(stream.inputSchema)
  return fields === undefined ? { value: {} } : formValue(fields, {})
}

/**
 * A fresh choice for `stream` going `route`: no filters (so a filter the server requires asks to be filled in),
 * goblin's instruction, and Tell me for a hand-over as the server suggests (an event it recommends without `tellMe` is
 * work for the agent, not a notice), else on.
 */
export const choiceFor = (stream: EventStream, route: EventRoute): EventChoice => ({
  route,
  filters: startingFilters(stream),
  instruction: '',
  tellMe: stream.tellMe ?? stream.recommended !== true,
  telegram: false,
})

/** A hand-over's limits as the picker sets them; the full editor changes them later. */
const BUDGET: RoutineBudget = { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 }

/** The instruction goblin writes for a hand-over the owner left without one. */
export const defaultInstruction = (stream: EventStream, server: Pick<ServerView, 'label'>): string =>
  `Each time "${eventTitle(stream)}" comes from ${server.label}, see what it needs and act on it.`

/** The routine one picked event makes, in the Topic it lives in; or what to fix first. */
export type EventSetUp = { readonly topic: number; readonly definition: RoutineDefinition }

/**
 * The routine `choice` makes for `stream`: a Topic route only tells (always on); a hand-over carries the instruction
 * (or goblin's), no tools yet and the usual limits, and tells as the owner chose. A Persona is pinned at its revision
 * now and answers in Personal.
 */
export function setUpOf(
  stream: EventStream,
  server: Pick<ServerView, 'connectionId' | 'label'>,
  choice: EventChoice,
  personas: readonly Pick<PersonaView, 'id' | 'revision'>[],
  timezone: string,
): EventSetUp | { readonly problem: string } {
  if ('problem' in choice.filters) return { problem: `${eventTitle(stream)}: ${choice.filters.problem}` }
  const { route } = choice
  const trigger = {
    kind: 'event',
    connectionId: server.connectionId,
    name: stream.name,
    arguments: choice.filters.value,
  } as const
  const title = `${eventTitle(stream)} from ${server.label}`.slice(0, 120)
  if (route.kind === 'tell')
    return {
      topic: route.topic,
      definition: {
        title,
        timezone,
        trigger,
        tellMe: { on: true, telegram: choice.telegram },
        handTo: { kind: 'none' },
      },
    }
  const instruction = choice.instruction.trim() || defaultInstruction(stream, server)
  const handOver = { instruction: instruction.slice(0, 12_000), allowedTools: [], budget: BUDGET }
  const tellMe = { on: choice.tellMe, telegram: choice.tellMe && choice.telegram }
  if (route.kind === 'goblin')
    return {
      topic: route.topic,
      definition: { title, timezone, trigger, tellMe, handTo: { kind: 'goblin', ...handOver } },
    }
  const persona = personas.find((each) => each.id === route.persona)
  if (persona === undefined) return { problem: `${eventTitle(stream)}: pick a Persona that is still there.` }
  return {
    topic: PERSONAL_TOPIC,
    definition: {
      title,
      timezone,
      trigger,
      tellMe,
      handTo: { kind: 'persona', persona: persona.id, revision: persona.revision, ...handOver },
    },
  }
}
