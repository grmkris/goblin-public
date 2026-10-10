import type { CreatePersona, PersonaDefinition, PersonaView, UpdatePersona } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import type { NewReceipt } from '../organize/receipts.ts'
import { Receipts } from '../organize/service.ts'
import type { PersonaActor } from './registry.ts'
import { Personas } from './service.ts'

/** Who changed a Persona and from where: the receipt it leaves says so. `chat` is the run that did it, for the agent. */
export type PersonaProvenance = { readonly actor: PersonaActor; readonly chat?: string; readonly operationId?: string }

/** One Persona with its revisions. */
export const personaDetail = (id: number) => Personas.use((personas) => personas.detail(id))

/** What Undo restores: a Persona's definition and whether it was archived. */
export type PersonaSnapshot = PersonaDefinition & { readonly archived: boolean }

export const snapshotOf = (persona: PersonaView): PersonaSnapshot => ({
  name: persona.name,
  avatar: persona.avatar,
  role: persona.role,
  instructions: persona.instructions,
  ...(persona.model === undefined ? {} : { model: persona.model }),
  exclusions: persona.exclusions,
  archived: persona.archivedAt !== undefined,
})

/** A new Persona at revision 1, or the one this operation id already made; a new one leaves a receipt. */
export const createPersona = (input: CreatePersona, provenance: PersonaProvenance) =>
  Effect.gen(function* () {
    const personas = yield* Personas
    const receipts = yield* Receipts
    const made = yield* personas.create(input, provenance.actor)
    if (made.created)
      yield* receipts.record({
        kind: 'persona.create',
        target: String(made.persona.id),
        summary: `Created persona @${made.persona.name}`,
        actor: provenance.actor,
        ...(provenance.chat === undefined ? {} : { chat: provenance.chat }),
        before: null,
        after: snapshotOf(made.persona),
        afterRevision: made.persona.revision,
        operationId: `persona.create:${input.operationId}`,
      })
    return made.persona
  })

/** What a change did to a Persona, in a line. */
function summaryOf(before: PersonaView, after: PersonaView): string {
  if (after.archivedAt !== undefined && before.archivedAt === undefined) return `Archived persona @${after.name}`
  if (after.archivedAt === undefined && before.archivedAt !== undefined) return `Restored persona @${after.name}`
  if (after.name !== before.name) return `Renamed persona @${before.name} to @${after.name}`
  return `Updated persona @${after.name}`
}

/** A new revision of a Persona (the revision it edits is `expectedRevision`); a real change leaves a receipt. */
export const updatePersona = (id: number, change: UpdatePersona, provenance: PersonaProvenance) =>
  Effect.gen(function* () {
    const personas = yield* Personas
    const receipts = yield* Receipts
    const { before, after } = yield* personas.update(id, change, provenance.actor)
    if (after.revision !== before.revision) {
      const receipt: NewReceipt = {
        kind: 'persona.update',
        target: String(id),
        summary: summaryOf(before, after),
        actor: provenance.actor,
        ...(provenance.chat === undefined ? {} : { chat: provenance.chat }),
        before: snapshotOf(before),
        after: snapshotOf(after),
        afterRevision: after.revision,
        ...(provenance.operationId === undefined ? {} : { operationId: `persona.update:${provenance.operationId}` }),
      }
      yield* receipts.record(receipt)
    }
    return after
  })
