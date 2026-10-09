import type { RoutineDefinition, RoutineEdit, RoutineRevision, RoutineSettings } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { nextInt } from 'effect/Random'
import { Entitlements } from '../billing/gates.ts'
import { Chats } from '../chats/service.ts'
import { Routines } from './service.ts'

export const routinesList = Effect.gen(function* () {
  const store = yield* Routines
  return { routines: yield* store.list() }
})
/** A draft routine, owned by `topic` (the Topic of the chat that proposed it; Personal by default). */
export const proposeRoutine = Effect.fn('routines.propose')(function* (
  definition: RoutineDefinition,
  operationId: string,
  topic?: number,
) {
  yield* Entitlements.use((plans) => plans.require('routines'))
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
  const topic = Option.isNone(chat) ? undefined : yield* chats.topicOf(chat.value)
  return yield* proposeRoutine(definition, operationId, topic)
})
export const editRoutine = Effect.fn('routines.edit')(function* (id: string, input: RoutineEdit) {
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  return (yield* store.edit(id, input.revision, input.definition, input.operationId, at)).routine
})
export const changeRoutine = Effect.fn('routines.changeRevision')(function* (
  id: string,
  input: RoutineRevision,
  action: 'confirm' | 'pause' | 'archive',
) {
  yield* Entitlements.use((plans) => plans.require('routines'))
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  return (yield* store[action](id, input.revision, input.operationId, at)).routine
})

export const setRoutineSettings = Effect.fn('routines.setSettings')(function* (settings: RoutineSettings) {
  const store = yield* Routines
  yield* store.updateSettings(settings.timezone, settings.maxActive, settings.maxRunning)
  return yield* store.settings
})
