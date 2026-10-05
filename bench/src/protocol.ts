import { Schema } from 'effect'
import { Manifest, SourceEvent } from './schema.ts'

/** The worker never receives the private fact ledger or expected values. */
export const ReplayEvent = Schema.Struct({
  id: SourceEvent.fields.id,
  kind: SourceEvent.fields.kind,
  text: SourceEvent.fields.text,
  callId: SourceEvent.fields.callId,
  toolName: SourceEvent.fields.toolName,
  arguments: SourceEvent.fields.arguments,
  timestamp: SourceEvent.fields.timestamp,
  isError: SourceEvent.fields.isError,
  groupId: SourceEvent.fields.groupId,
})
export type ReplayEvent = typeof ReplayEvent.Type
export const BuildRequest = Schema.Struct({
  identity: Schema.String,
  manifest: Manifest,
  policy: Schema.Literals(['optchat', 'standard']),
  writer: Schema.String,
  events: Schema.Array(ReplayEvent),
})
export type BuildRequest = typeof BuildRequest.Type
export const ProbeRequest = Schema.Struct({
  id: Schema.String,
  reader: Schema.String,
  question: Schema.String,
  search: Schema.Boolean,
  cutoff: Schema.Int.check(Schema.isGreaterThan(0)),
  recallGuide: Schema.NullOr(Schema.String),
})
export type ProbeRequest = typeof ProbeRequest.Type

export function publicEvents(events: readonly SourceEvent[]): ReplayEvent[] {
  return events.map(({ fact: _fact, provenance: _provenance, ...event }) => event)
}

export const Delivery = Schema.Struct({
  id: Schema.String,
  kind: SourceEvent.fields.kind,
  offsetBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  endBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String,
  origin: Schema.Literals(['context', 'zoom', 'search', 'read']),
})
export type Delivery = typeof Delivery.Type
export const RetrievalRecord = Schema.Struct({
  operation: Schema.Literals(['zoom', 'archive_search', 'archive_read']),
  text: Schema.String,
  denied: Schema.Boolean,
})
export type RetrievalRecord = typeof RetrievalRecord.Type
export const ProbeResult = Schema.Struct({
  status: Schema.Literals(['done', 'unanswered']),
  text: Schema.String,
  retrieval: Schema.Array(RetrievalRecord),
  deliveries: Schema.Array(Delivery),
  context: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
})
export type ProbeResult = typeof ProbeResult.Type
