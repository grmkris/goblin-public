import type { RoutineDefinition, RoutineEdit, RoutineRevision, RoutineSettings } from '@purrable/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { nextInt } from 'effect/Random'
import { Entitlements } from '../billing/gates.ts'
import { Routines, attemptSync } from '../services.ts'

export const routinesList = Effect.gen(function* () {
  const store = yield* Routines
  return { routines: store.list() }
})
export const proposeRoutine = (definition: RoutineDefinition, operationId: string) =>
  Effect.gen(function* () {
    yield* Entitlements.use((plans) => plans.require('routines'))
    const store = yield* Routines
    const at = yield* Clock.currentTimeMillis
    const suffix = yield* nextInt
    return (yield* attemptSync(() => store.propose(definition, operationId, `rt_${at}_${Math.abs(suffix)}`, at)))
      .routine
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
