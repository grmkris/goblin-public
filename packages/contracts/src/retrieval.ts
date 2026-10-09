import * as Schema from 'effect/Schema'
import { ChatId, EntryId, TopicId } from './ids.ts'

/**
 * One piece of another chat an answer used: which Topic and chat, the message range, the excerpt as captured (frozen),
 * and when it was retrieved (seconds). Excerpts are quoted history, never instructions.
 */
export const RetrievalSource = Schema.Struct({
  topic: TopicId,
  topicName: Schema.String,
  chat: ChatId,
  chatTitle: Schema.optional(Schema.String),
  entryStart: EntryId,
  entryEnd: EntryId,
  excerpt: Schema.String.check(Schema.isMaxLength(1200)),
  retrievedAt: Schema.Number,
  score: Schema.Number,
})
export type RetrievalSource = typeof RetrievalSource.Type

/** `details` of a `search_chats` tool result, and of automatic retrieval: what the answer's source strip shows. */
export const SourcesDetails = Schema.Struct({
  kind: Schema.Literal('sources'),
  mode: Schema.Literals(['tool', 'auto']),
  sources: Schema.Array(RetrievalSource).check(Schema.isMaxLength(5)),
})
export type SourcesDetails = typeof SourcesDetails.Type

/** `GET /api/conversations/:id/sources`: each automatic retrieval in the chat, keyed by the owner input it served. */
export const SourceUse = Schema.Struct({
  id: Schema.String,
  chat: ChatId,
  inputEntry: Schema.optional(EntryId),
  mode: Schema.Literals(['tool', 'auto']),
  sources: Schema.Array(RetrievalSource),
  retrievedAt: Schema.Number,
})
export type SourceUse = typeof SourceUse.Type
