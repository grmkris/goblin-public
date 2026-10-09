import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

/**
 * A row this agent wrote does not read back as what it wrote. It is the agent's fault, never the caller's: it reaches
 * the owner as `Internal` and is reported with its stack locations (ADR 0024). `what` names the data, never its value.
 */
export class StoredDataInvalid extends Schema.TaggedError<StoredDataInvalid>()('StoredDataInvalid', {
  what: Schema.String,
}) {}

/**
 * Reads JSON text this agent stored as `schema` says it wrote it; anything else (text that is not JSON, or a value of
 * another shape) is `StoredDataInvalid` naming `what`.
 */
export function storedJson<S extends Schema.Constraint & Schema.ConstraintDecoder<unknown>>(schema: S, what: string) {
  const decode = Schema.decodeUnknownOption(Schema.fromJsonString(schema))
  return (text: string): S['Type'] => Option.getOrThrowWith(decode(text), () => new StoredDataInvalid({ what }))
}

/** Any JSON value this agent stored: an app's state, a snapshot, a job's input, a receipt. */
export const storedValue = (what: string) => storedJson(Schema.Unknown, what)

/** A release's files, or its built modules: name to text. */
export const readFiles = storedJson(Schema.Record(Schema.String, Schema.String), 'release files')
