import * as Schema from 'effect/Schema'
import { HelperExclusions } from './capabilities.ts'
import { ChatId, EntryId, OperationId, PersonaId } from './ids.ts'

/** A Persona's name, as `@name` in the composer: a letter, then up to 31 letters, digits, spaces, `_` or `-`. */
export const PersonaName = Schema.String.check(Schema.isPattern(/^[A-Za-z][\w -]{0,31}$/u))

/** A small mark: one to four characters on a hue (0–359). */
export const PersonaAvatar = Schema.Struct({
  glyph: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  hue: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(359)),
})
export type PersonaAvatar = typeof PersonaAvatar.Type

/**
 * A Persona's definition (spec §5): a global name, its role in a line, its instructions, an optional model from the
 * offered list, and the capabilities it may not use. Exclusions only narrow the owner's grants; a Persona never gains
 * one.
 */
export const PersonaDefinition = Schema.Struct({
  name: PersonaName,
  avatar: PersonaAvatar,
  role: Schema.String.check(Schema.isMaxLength(120)),
  instructions: Schema.String.check(Schema.isMaxLength(8000)),
  model: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  exclusions: HelperExclusions,
})
export type PersonaDefinition = typeof PersonaDefinition.Type

/** A Persona at its current revision. An archived one no longer answers but keeps its history. Times in seconds. */
export const PersonaView = Schema.Struct({
  ...PersonaDefinition.fields,
  id: PersonaId,
  revision: Schema.Int,
  archivedAt: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type PersonaView = typeof PersonaView.Type

/** `POST /api/personas`: the same operation id finds the same Persona. */
export const CreatePersona = Schema.Struct({ ...PersonaDefinition.fields, operationId: OperationId })
export type CreatePersona = typeof CreatePersona.Type

/**
 * `PATCH /api/personas/:id`: a new revision. `expectedRevision` must be the current one, so two edits never silently
 * overwrite each other. `model: null` clears the preference.
 */
export const UpdatePersona = Schema.Struct({
  name: Schema.optional(PersonaName),
  avatar: Schema.optional(PersonaAvatar),
  role: Schema.optional(PersonaDefinition.fields.role),
  instructions: Schema.optional(PersonaDefinition.fields.instructions),
  model: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)))),
  exclusions: Schema.optional(HelperExclusions),
  archived: Schema.optional(Schema.Boolean),
  expectedRevision: Schema.Int,
})
export type UpdatePersona = typeof UpdatePersona.Type

/** One stored revision: what the Persona was, who changed it and when. Invocations keep the revision they used. */
export const PersonaRevisionView = Schema.Struct({
  ...PersonaDefinition.fields,
  revision: Schema.Int,
  actor: Schema.Literals(['owner', 'agent']),
  createdAt: Schema.Number,
})
export type PersonaRevisionView = typeof PersonaRevisionView.Type

/** `GET /api/personas/:id`: the Persona with its revisions, newest first. */
export const PersonaDetail = Schema.Struct({
  persona: PersonaView,
  revisions: Schema.Array(PersonaRevisionView),
})
export type PersonaDetail = typeof PersonaDetail.Type

/**
 * One tagged Persona answering one owner message: `order` is its place when the owner asked them in sequence ("then"),
 * otherwise they answer in parallel. `answerEntry` is the attributed answer written into `chat`.
 */
export const PersonaInvocationView = Schema.Struct({
  operationId: OperationId,
  persona: PersonaId,
  revision: Schema.Int,
  chat: ChatId,
  order: Schema.Int,
  state: Schema.Literals(['pending', 'running', 'answered', 'failed', 'stopped']),
  answerEntry: Schema.optional(EntryId),
  createdAt: Schema.Number,
  settledAt: Schema.optional(Schema.Number),
})
export type PersonaInvocationView = typeof PersonaInvocationView.Type

/** Who a tagged message went to: each Persona at the revision the invocation froze. */
export const PersonaTag = Schema.Struct({ id: PersonaId, name: Schema.String, revision: Schema.Int })

/** `app.persona_ask` entry data: the owner's message went to these Personas, not to Goblin. */
export const PersonaAskData = Schema.Struct({
  personas: Schema.Array(PersonaTag).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  order: Schema.Literals(['parallel', 'sequence']),
})
export type PersonaAskData = typeof PersonaAskData.Type

/** `app.persona` entry data: one Persona's attributed answer, written into the chat it was asked in. */
export const PersonaAnswerData = Schema.Struct({
  persona: PersonaId,
  name: Schema.String,
  revision: Schema.Int,
  avatar: PersonaAvatar,
  operationId: OperationId,
  text: Schema.String,
})
export type PersonaAnswerData = typeof PersonaAnswerData.Type
