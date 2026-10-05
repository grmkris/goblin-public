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

export const ProbeResult = Schema.Struct({
  status: Schema.Literals(['done', 'unanswered']),
  text: Schema.String,
  retrieval: Schema.Array(Schema.Struct({ text: Schema.String, denied: Schema.Boolean })),
  context: Schema.Array(Schema.Struct({ role: Schema.String, text: Schema.String })),
})
export type ProbeResult = typeof ProbeResult.Type
