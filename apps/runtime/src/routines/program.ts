import {
  PERSONAL_TOPIC,
  type RoutineDefinition,
  type RoutineHandTo,
  type RoutineEdit,
  type RoutineRevision,
  type RoutineSettings,
} from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { nextInt } from 'effect/Random'
import { requirePlan } from '../billing/gates.ts'
import { Chats } from '../chats/service.ts'
import { personaNamed } from '../personas/program.ts'
import { topicNamed } from '../topics/program.ts'
import { RoutineControl, Routines } from './service.ts'

export const routinesList = Effect.gen(function* () {
  const store = yield* Routines
  return { routines: yield* store.list() }
})
/** A draft routine, owned by Topic `topic`: the one the owner named, or the Topic of the chat that proposed it. */
export const proposeRoutine = Effect.fn('routines.propose')(function* (
  definition: RoutineDefinition,
  operationId: string,
  topic: number,
) {
  yield* requirePlan('routines')
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  const suffix = yield* nextInt
  const id = `rt_${at}_${Math.abs(suffix)}`
  return (yield* store.propose(definition, operationId, id, at, topic)).routine
})

/** A draft routine proposed from the Pi session `session`: its chat's Topic owns it, else Personal. */
export const proposeRoutineFrom = Effect.fn('routines.proposeFrom')(function* (
  definition: RoutineDefinition,
  operationId: string,
  session: string,
) {
  const chats = yield* Chats
  const chat = yield* chats.chatOf(session)
  const topic = Option.isNone(chat) ? PERSONAL_TOPIC : yield* chats.topicOf(chat.value)
  return yield* proposeRoutine(definition, operationId, topic)
})
/**
 * Who a proposal from the model hands its work to: nobody, Goblin, or a Persona by its name, whose revision now the
 * program pins (ADR 0041).
 */
export type AskedHandTo =
  | Exclude<RoutineHandTo, { readonly kind: 'persona' }>
  | (Omit<Extract<RoutineHandTo, { readonly kind: 'persona' }>, 'persona' | 'revision'> & { readonly persona: string })

/** A routine as the model proposes it: its definition with the Persona by name, and the Topic by name if not this one. */
export type AskedRoutine = Omit<RoutineDefinition, 'handTo'> & { readonly handTo: AskedHandTo; readonly topic?: string }

/** The hand-over `asked` names, with a Persona's name resolved to it at its revision now. */
const handToOf = (asked: AskedHandTo) =>
  Effect.gen(function* () {
    if (asked.kind !== 'persona') return asked
    const persona = yield* personaNamed(asked.persona)
    return { ...asked, persona: persona.id, revision: persona.revision } satisfies RoutineHandTo
  })

/**
 * A draft routine the model proposed from the Pi session `session`: in the Topic it names, else its chat's Topic (else
 * Personal), handed to the Persona it names at that Persona's revision now. The owner reviews it before it runs.
 */
export const proposeAsked = Effect.fn('routines.proposeAsked')(function* (
  asked: AskedRoutine,
  operationId: string,
  session: string,
) {
  const { topic: topicName, handTo, ...rest } = asked
  const definition = { ...rest, handTo: yield* handToOf(handTo) }
  if (topicName === undefined) return yield* proposeRoutineFrom(definition, operationId, session)
  return yield* proposeRoutine(definition, operationId, (yield* topicNamed(topicName)).id)
})

export const editRoutine = Effect.fn('routines.edit')(function* (id: string, input: RoutineEdit) {
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  return (yield* store.edit(id, input, at)).routine
})
/** What the owner does to one revision of a routine; "confirm again" repins its Persona first (ADR 0041). */
type RoutineAction = 'confirm' | 'confirmAgain' | 'pause' | 'archive'

export const changeRoutine = Effect.fn('routines.changeRevision')(function* (
  id: string,
  input: RoutineRevision,
  action: RoutineAction,
) {
  yield* requirePlan('routines')
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  return (yield* store[action](id, input.revision, input.operationId, at)).routine
})

export const setRoutineSettings = Effect.fn('routines.setSettings')(function* (settings: RoutineSettings) {
  const store = yield* Routines
  yield* store.updateSettings(settings.timezone, settings.maxActive, settings.maxRunning)
  return yield* store.settings
})

/**
 * The owner confirms (or confirms again), pauses or archives a routine: a confirm subscribes an event routine, archive
 * stops its runs.
 */
export const routineChange = Effect.fn('routines.change')(function* (
  id: string,
  input: RoutineRevision,
  action: RoutineAction,
) {
  const changed = yield* changeRoutine(id, input, action)
  const control = yield* RoutineControl
  if (action === 'confirm' || action === 'confirmAgain') yield* control.confirmEvents(changed.id, changed.revision)
  if (action === 'archive') yield* control.archive(id)
  yield* control.reconcile
  return yield* (yield* Routines).view(id)
})
