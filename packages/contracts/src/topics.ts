import * as Schema from 'effect/Schema'
import { ChatId, EntryId, NonEmptyString, OperationId, TopicId } from './ids.ts'
import { SetupItems, TopicSetup } from './setup.ts'

export const TopicName = NonEmptyString(80)

/**
 * A Topic: a durable container with exactly one Conversation (`conversation`) and any number of Threads under it.
 * Personal (`personal`, id 1) holds today's Main as its Conversation and receives every inbound channel. An archived
 * Topic (`archivedAt`) is out of navigation and default search; `searchExcluded` keeps it out of automatic search while
 * active. `revision` counts changes, so an undo can tell whether something touched it since. `setup` is what its chats
 * work with (ADR 0040). Times are in seconds.
 */
export const TopicView = Schema.Struct({
  id: TopicId,
  name: Schema.String,
  conversation: ChatId,
  personal: Schema.optional(Schema.Boolean),
  archivedAt: Schema.optional(Schema.Number),
  searchExcluded: Schema.Boolean,
  revision: Schema.Int,
  setup: TopicSetup,
  createdBy: Schema.Literals(['owner', 'agent', 'system']),
  createdAt: Schema.Number,
})
export type TopicView = typeof TopicView.Type

/**
 * `POST /api/topics`: the same operation id finds the same Topic. A new Topic opens its Conversation, with `setup` or
 * everything the owner allows.
 */
export const CreateTopic = Schema.Struct({
  name: TopicName,
  operationId: OperationId,
  setup: Schema.optional(TopicSetup),
})
export type CreateTopic = typeof CreateTopic.Type

/** `PATCH /api/topics/:id`. Personal cannot be archived. */
export const UpdateTopic = Schema.Struct({
  name: Schema.optional(TopicName),
  archived: Schema.optional(Schema.Boolean),
  searchExcluded: Schema.optional(Schema.Boolean),
})
export type UpdateTopic = typeof UpdateTopic.Type

/**
 * `PATCH /api/topics/:id/setup` (ADR 0040): a whole new setup (`expectedRevision` must be the Topic's revision now, so
 * two edits never silently overwrite each other), or items added to or removed from it. Removing from a category that
 * holds everything lists what the owner allows now, less the item.
 */
export const TopicSetupEdit = Schema.Union([
  Schema.Struct({ set: TopicSetup, expectedRevision: Schema.Int }),
  Schema.Struct({ add: SetupItems }),
  Schema.Struct({ remove: SetupItems }),
])
export type TopicSetupEdit = typeof TopicSetupEdit.Type

/** A routine of the Topic whose allowed tools the setup now leaves out: those tools are refused when it runs. */
export const RoutineOutsideSetup = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  outside: Schema.Array(Schema.Struct({ serverId: Schema.String, name: Schema.String })),
})
export type RoutineOutsideSetup = typeof RoutineOutsideSetup.Type

/** What a setup edit answers: the Topic as it is now, and the routines it leaves without some of their tools. */
export const TopicSetupSaved = Schema.Struct({ topic: TopicView, routines: Schema.Array(RoutineOutsideSetup) })
export type TopicSetupSaved = typeof TopicSetupSaved.Type

/**
 * What organizing changed, shown in Activity with Undo: who did it (`actor`), to what (`target`, a Topic or Persona
 * id), a one-line `summary`, and the chat whose run did it. `undoable` is false once a later edit touched the target.
 */
export const OrganizeReceipt = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    'topic.create',
    'topic.rename',
    'topic.archive',
    'topic.restore',
    'topic.setup',
    'persona.create',
    'persona.update',
  ]),
  target: Schema.String,
  summary: Schema.String,
  actor: Schema.Literals(['owner', 'agent']),
  chat: Schema.optional(ChatId),
  at: Schema.Number,
  undoneAt: Schema.optional(Schema.Number),
  undoable: Schema.Boolean,
})
export type OrganizeReceipt = typeof OrganizeReceipt.Type

/** A frozen excerpt a new Topic was seeded with: where it came from and the text as it was. */
export const SourceReference = Schema.Struct({
  chat: ChatId,
  entryStart: EntryId,
  entryEnd: EntryId,
  excerpt: Schema.String.check(Schema.isMaxLength(1200)),
})
export type SourceReference = typeof SourceReference.Type

/** `app.topic_seed` entry data: the compact brief and frozen references a Topic made from a discussion starts with. */
export const TopicSeedData = Schema.Struct({
  brief: Schema.String.check(Schema.isMaxLength(4000)),
  sources: Schema.Array(SourceReference).check(Schema.isMaxLength(8)),
})
export type TopicSeedData = typeof TopicSeedData.Type
