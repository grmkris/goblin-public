import {
  type OrganizeReceipt,
  type PersonaDefinition,
  PersonaDefinition as PersonaDefinitionSchema,
  TopicSetup,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Conflict, InvalidInput } from '../http/errors.ts'
import { updatePersona } from '../personas/program.ts'
import { Personas } from '../personas/service.ts'
import { editTopicSetup, updateTopic } from '../topics/program.ts'
import { Topics } from '../topics/service.ts'
import { withFlow } from '../observability/flows.ts'
import { Receipts } from './service.ts'

const TopicBefore = Schema.NullOr(Schema.Struct({ name: Schema.String, archived: Schema.Boolean }))
/** A Persona as a receipt kept it: its definition, setup included, and whether it was archived. */
const PersonaBefore = Schema.NullOr(Schema.Struct({ ...PersonaDefinitionSchema.fields, archived: Schema.Boolean }))
/** A Topic's setup as a `topic.setup` receipt kept it (ADR 0040). */
const SetupBefore = Schema.Struct({ setup: TopicSetup })
const decodeTopic = Schema.decodeUnknownEffect(TopicBefore)
const decodeSetup = Schema.decodeUnknownEffect(SetupBefore)
const decodePersona = Schema.decodeUnknownEffect(PersonaBefore)

/** What Undo of each kind does to the target, as the change that restores `before`. */
type Plan =
  | { readonly target: 'topic'; readonly id: number; readonly name?: string; readonly archived: boolean }
  | { readonly target: 'setup'; readonly id: number; readonly setup: TopicSetup }
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
    const plan = yield* planOf(stored.kind, target, stored.before)
    if (plan.target === 'setup') {
      yield* editTopicSetup(plan.id, { set: plan.setup, expectedRevision: revision }, { actor: 'owner' })
    } else if (plan.target === 'topic') {
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
    return undone
  }).pipe(withFlow(flow, (undone) => (undone.kind.startsWith('topic.') ? { topic: Number(undone.target) } : {})))
}

/**
 * The change that restores a receipt's `before`. A snapshot that does not decode is refused as the synchronous decode
 * was (`InvalidInput`).
 */
const planOf = (kind: OrganizeReceipt['kind'], target: number, before: unknown): Effect.Effect<Plan, InvalidInput> =>
  (kind === 'topic.setup'
    ? Effect.map(decodeSetup(before), ({ setup }): Plan => ({ target: 'setup', id: target, setup }))
    : kind.startsWith('topic.')
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
