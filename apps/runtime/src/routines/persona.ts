import * as Effect from 'effect/Effect'
import type { PersonaBinding } from '../chats/service.ts'
import { frozenAt } from '../personas/ask.ts'
import { Personas } from '../personas/service.ts'
import type { RoutineRun } from './runs.ts'
import { Routines } from './service.ts'
import { definitionOf } from './store.ts'

// A routine that hands its work to a Persona (ADR 0041): the Persona answers at the revision the owner confirmed with
// the routine, and a Persona archived or changed since stops the routine until the owner confirms it again.

/** Why a firing of a routine handed to a Persona does not run: the Persona is gone or archived, or changed since. */
export type PersonaHold = 'persona_archived' | 'persona_changed'

/** What holds routine `routineId`'s next run back: its Persona as it is now against the pin; none for any other. */
export const personaHold = Effect.fn('routines.personaHold')(function* (routineId: string) {
  const { handTo } = definitionOf(yield* (yield* Routines).get(routineId))
  if (handTo.kind !== 'persona') return undefined
  const persona = yield* (yield* Personas)
    .get(handTo.persona)
    .pipe(Effect.catchTag('NotFound', () => Effect.succeed(undefined)))
  if (persona === undefined || persona.archivedAt !== undefined) return 'persona_archived' satisfies PersonaHold
  return persona.revision === handTo.revision ? undefined : ('persona_changed' satisfies PersonaHold)
})

/** The Persona run `record` is handed to, at the pinned revision, with its model when offered; none for Goblin's. */
export const runPersona = Effect.fn('routines.runPersona')(function* (record: RoutineRun) {
  const { handTo } = definitionOf(record)
  if (handTo.kind !== 'persona') return undefined
  return yield* frozenAt(handTo.persona, handTo.revision)
})

/** The Persona a run's conversation is bound to, with the setup it adds there (ADR 0040); none for Goblin's run. */
export const runBinding = Effect.fn('routines.runBinding')(function* (record: RoutineRun) {
  const persona = yield* runPersona(record)
  if (persona === undefined) return undefined
  const { id, revision, name, setup } = persona
  return { id, revision, name, setup } satisfies PersonaBinding
})
