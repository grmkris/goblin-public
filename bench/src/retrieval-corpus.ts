import { Schema } from 'effect'

export const TranscriptMessage = Schema.Struct({
  entryId: Schema.Int.check(Schema.isGreaterThan(0)),
  sessionId: Schema.String,
  chatId: Schema.String,
  role: Schema.Literals(['user', 'assistant', 'tool']),
  author: Schema.String,
  at: Schema.Int,
  text: Schema.String,
})
export type TranscriptMessage = typeof TranscriptMessage.Type
export const RetrievalLabel = Schema.Struct({
  id: Schema.String,
  query: Schema.String,
  kind: Schema.Literals(['exact', 'semantic', 'none', 'superseded']),
  targets: Schema.Array(Schema.Struct({ chatId: Schema.String, start: Schema.Int, end: Schema.Int })),
})
export type RetrievalLabel = typeof RetrievalLabel.Type
export const RetrievalFixture = Schema.Struct({
  messages: Schema.Array(TranscriptMessage),
  labels: Schema.Array(RetrievalLabel),
})
