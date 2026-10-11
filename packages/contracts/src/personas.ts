import * as Schema from 'effect/Schema'
import { ChatId, EntryId, NonEmptyString, OperationId, PersonaId } from './ids.ts'
import { PersonaSetup } from './setup.ts'

/** A Persona's name, as `@name` in the composer: a letter, then up to 31 letters, digits, spaces, `_` or `-`. */
export const PersonaName = Schema.String.check(Schema.isPattern(/^[A-Za-z][\w -]{0,31}$/u))

/** A small mark: one to four characters on a hue (0–359). */
export const PersonaAvatar = Schema.Struct({
  glyph: NonEmptyString(4),
  hue: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(359)),
})
export type PersonaAvatar = typeof PersonaAvatar.Type

/**
 * A Persona's definition (ADR 0033): a global name, its role in a line, its instructions, an optional model from the
 * offered list, and its setup: the MCP servers, skills and apps it adds to the setup of the Topic it answers in
 * (ADR 0040). A setup only chooses among the owner's grants; a Persona never gains one.
 */
export const PersonaDefinition = Schema.Struct({
  name: PersonaName,
  avatar: PersonaAvatar,
  role: Schema.String.check(Schema.isMaxLength(120)),
  instructions: Schema.String.check(Schema.isMaxLength(8000)),
  model: Schema.optional(NonEmptyString(128)),
  setup: PersonaSetup,
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

/** `POST /api/personas`: the same operation id finds the same Persona. Without a setup it adds nothing. */
export const CreatePersona = Schema.Struct({
  ...PersonaDefinition.fields,
  setup: Schema.optional(PersonaSetup),
  operationId: OperationId,
})
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
  model: Schema.optional(Schema.NullOr(NonEmptyString(128))),
  setup: Schema.optional(PersonaSetup),
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

/**
 * What a Persona's answer waits on (ADR 0041): a held call the owner approves or refuses, or a tool the owner allows.
 * `fork` is the Persona's own chat, which goes on from the owner's reply.
 */
export const PersonaHold = Schema.Struct({
  kind: Schema.Literals(['approval', 'grant']),
  /** The held call, for an approval. */
  approvalId: Schema.optional(Schema.String),
  connectionId: Schema.String,
  name: Schema.String,
  fork: ChatId,
})
export type PersonaHold = typeof PersonaHold.Type

/**
 * `app.persona` entry data: one Persona's attributed answer, written into the chat it was asked in, or into its
 * routine's Topic when a routine handed it the work.
 */
export const PersonaAnswerData = Schema.Struct({
  persona: PersonaId,
  name: Schema.String,
  revision: Schema.Int,
  avatar: PersonaAvatar,
  operationId: OperationId,
  text: Schema.String,
  /** The routine run that handed the Persona its work (ADR 0041), when no owner message did. */
  routine: Schema.optional(Schema.Struct({ id: Schema.String, run: Schema.String })),
  /** What the answer stopped on, when the Persona needs the owner before it can go on (ADR 0041). */
  hold: Schema.optional(PersonaHold),
})
export type PersonaAnswerData = typeof PersonaAnswerData.Type

/**
 * `POST /api/personas/reply`: the owner's reply to a Persona's hold (ADR 0041), after they allowed the tool it asked
 * for. The Persona goes on in its fork and answers again; the same operation id answers once.
 */
export const PersonaReply = Schema.Struct({
  fork: ChatId,
  operationId: OperationId,
  text: NonEmptyString(4000),
})
export type PersonaReply = typeof PersonaReply.Type
