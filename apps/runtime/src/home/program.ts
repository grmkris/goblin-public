import type { HomeEdit } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Home, attemptSync, requireResident } from '../services.ts'

export const readHomeLayout = Effect.andThen(
  requireResident,
  Home.use((home) => attemptSync(() => home.read())),
)
export const editHomeLayout = (input: HomeEdit, actor: 'owner' | 'agent') =>
  Effect.gen(function* () {
    if (actor === 'agent') yield* requireResident
    return yield* Home.use((home) => attemptSync(() => home.edit(input, actor)))
  })
