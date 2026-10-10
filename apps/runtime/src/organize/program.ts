import {
  type OrganizeReceipt,
  type PersonaDefinition,
  PersonaDefinition as PersonaDefinitionSchema,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Conflict, InvalidInput } from '../http/errors.ts'
import { updatePersona } from '../personas/program.ts'
import { Personas } from '../personas/service.ts'
import { updateTopic } from '../topics/program.ts'
import { Topics } from '../topics/service.ts'
import { failedFlow, recordFlow } from './flows.ts'
import { Receipts } from './service.ts'

const TopicBefore = Schema.NullOr(Schema.Struct({ name: Schema.String, archived: Schema.Boolean }))
const PersonaBefore = Schema.NullOr(Schema.Struct({ ...PersonaDefinitionSchema.fields, archived: Schema.Boolean }))
const decodeTopic = Schema.decodeUnknownEffect(TopicBefore)
const decodePersona = Schema.decodeUnknownEffect(PersonaBefore)

/** What Undo of each kind does to the target, as the change that restores `before`. */
type Plan =
  | { readonly target: 'topic'; readonly id: number; readonly name?: string; readonly archived: boolean }
  | {
      readonly target: 'persona'
      readonly id: number
      readonly definition?: PersonaDefinition
      readonly archived: boolean
    }

/**
 * Undoes one receipt: the target goes back to what it was before the change. It is refused as `touched` (409) once
 * anything changed the target since (its revision is no longer the one the change left), and an Undo is itself not
 * undone. Undoing a creation archives the Topic or Persona; undoing an archive restores it.
 */
export const undoReceipt = (id: string) => {
  const flow = { flow: 'organize_undo', via: 'app', actor: 'owner' } as const
  return Effect.gen(function* () {
    const receipts = yield* Receipts
    const topics = yield* Topics
    const personas = yield* Personas
    const stored = yield* receipts.get(id)
    if (stored.undoneAt !== undefined) return yield* new Conflict({ reason: 'undone' })
    const target = Number(stored.target)
    const isTopic = stored.kind.startsWith('topic.')
    const revision = (isTopic ? yield* topics.get(target) : yield* personas.get(target)).revision
    if (revision !== stored.afterRevision) return yield* new Conflict({ reason: 'touched' })
    const plan = yield* planOf(isTopic, target, stored.before)
    if (plan.target === 'topic') {
      yield* updateTopic(
        plan.id,
        { ...(plan.name === undefined ? {} : { name: plan.name }), archived: plan.archived },
        { actor: 'owner' },
      )
    } else {
      yield* updatePersona(
        plan.id,
        {
          ...plan.definition,
          model: plan.definition?.model ?? null,
          archived: plan.archived,
          expectedRevision: revision,
        },
        { actor: 'owner' },
      )
    }
    const undone: OrganizeReceipt = yield* receipts.markUndone(id)
    if (undone.undoneAt === undefined) return yield* new InvalidInput({ reason: 'undo' })
    yield* recordFlow({ ...flow, ...(isTopic ? { topic: target } : {}), status: 'ok' })
    return undone
  }).pipe(Effect.tapError((error) => recordFlow({ ...flow, ...failedFlow(error) })))
}

/**
 * The change that restores a receipt's `before`. A snapshot that does not decode is refused as the synchronous decode
 * was (`InvalidInput`).
 */
const planOf = (isTopic: boolean, target: number, before: unknown): Effect.Effect<Plan, InvalidInput> =>
  (isTopic
    ? Effect.map(decodeTopic(before), (topic): Plan =>
        topic === null
          ? { target: 'topic', id: target, archived: true }
          : { target: 'topic', id: target, name: topic.name, archived: topic.archived },
      )
    : Effect.map(decodePersona(before), (persona): Plan => {
        if (persona === null) return { target: 'persona', id: target, archived: true }
        const { archived, ...definition } = persona
        return { target: 'persona', id: target, definition, archived }
      })
  ).pipe(Effect.mapError(() => new InvalidInput({ reason: 'schema' })))
