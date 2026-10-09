import {
  type OrganizeReceipt,
  type PersonaDefinition,
  PersonaDefinition as PersonaDefinitionSchema,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { Conflict, InvalidInput } from '../http/errors.ts'
import { updatePersona } from '../personas/program.ts'
import type { StopRuntime } from '../agent-program.ts'
import { Personas, Receipts, Topics, attemptSync, nowSecondsEffect } from '../services.ts'
import { updateTopic } from '../topics/program.ts'

/** The recent receipts, newest first. */
export const receiptList = Receipts.useSync((receipts) => receipts.list())

const TopicBefore = Schema.NullOr(Schema.Struct({ name: Schema.String, archived: Schema.Boolean }))
const PersonaBefore = Schema.NullOr(Schema.Struct({ ...PersonaDefinitionSchema.fields, archived: Schema.Boolean }))
const decodeTopic = Schema.decodeUnknownSync(TopicBefore)
const decodePersona = Schema.decodeUnknownSync(PersonaBefore)

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
export const undoReceipt = (runtime: StopRuntime, id: string) =>
  Effect.gen(function* () {
    const receipts = yield* Receipts
    const topics = yield* Topics
    const personas = yield* Personas
    const stored = yield* attemptSync(() => receipts.get(id))
    if (stored.undoneAt !== undefined) return yield* new Conflict({ reason: 'undone' })
    const target = Number(stored.target)
    const revision = yield* attemptSync(() =>
      stored.kind.startsWith('topic.') ? topics.get(target).revision : personas.get(target).revision,
    )
    if (revision !== stored.afterRevision) return yield* new Conflict({ reason: 'touched' })
    const plan = yield* attemptSync((): Plan => {
      if (stored.kind.startsWith('topic.')) {
        const before = decodeTopic(stored.before)
        return before === null
          ? { target: 'topic', id: target, archived: true }
          : { target: 'topic', id: target, name: before.name, archived: before.archived }
      }
      const persona = decodePersona(stored.before)
      if (persona === null) return { target: 'persona', id: target, archived: true }
      const { archived, ...definition } = persona
      return { target: 'persona', id: target, definition, archived }
    })
    if (plan.target === 'topic') {
      yield* updateTopic(
        runtime,
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
    const now = yield* nowSecondsEffect
    const undone: OrganizeReceipt = yield* attemptSync(() => receipts.markUndone(id, now))
    if (undone.undoneAt === undefined) return yield* new InvalidInput({ reason: 'undo' })
    return undone
  })
