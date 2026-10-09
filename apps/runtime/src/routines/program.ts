import type { RoutineDefinition, RoutineEdit, RoutineRevision, RoutineSettings } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { nextInt } from 'effect/Random'
import { Entitlements } from '../billing/gates.ts'
import { Chats, Routines, attemptSync } from '../services.ts'

export const routinesList = Effect.gen(function* () {
  const store = yield* Routines
  return { routines: store.list() }
})
/** A draft routine, owned by `topic` (the Topic of the chat that proposed it; Personal by default). */
export const proposeRoutine = (definition: RoutineDefinition, operationId: string, topic?: number) =>
  Effect.gen(function* () {
    yield* Entitlements.use((plans) => plans.require('routines'))
    const store = yield* Routines
    const at = yield* Clock.currentTimeMillis
    const suffix = yield* nextInt
    const id = `rt_${at}_${Math.abs(suffix)}`
    return (yield* attemptSync(() => store.propose(definition, operationId, id, at, topic))).routine
  })

/** A draft routine proposed from the Pi session `session`: its chat's Topic owns it, else Personal. */
export const proposeRoutineFrom = (definition: RoutineDefinition, operationId: string, session: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const chat = chats.chatOf(session)
    return yield* proposeRoutine(definition, operationId, chat === undefined ? undefined : chats.topicOf(chat))
  })
export const editRoutine = (id: string, input: RoutineEdit) =>
  Effect.gen(function* () {
    const store = yield* Routines
    const at = yield* Clock.currentTimeMillis
    return (yield* attemptSync(() => store.edit(id, input.revision, input.definition, input.operationId, at))).routine
  })
export const changeRoutine = (id: string, input: RoutineRevision, action: 'confirm' | 'pause' | 'archive') =>
  Effect.gen(function* () {
    yield* Entitlements.use((plans) => plans.require('routines'))
    const store = yield* Routines
    const at = yield* Clock.currentTimeMillis
    return (yield* attemptSync(() => store[action](id, input.revision, input.operationId, at))).routine
  })

export const setRoutineSettings = (settings: RoutineSettings) =>
  Routines.use((store) =>
    attemptSync(() => {
      store.settingsUpdate(settings.timezone, settings.maxActive, settings.maxRunning)
      return store.settings()
    }),
  )
