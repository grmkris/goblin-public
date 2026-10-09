import * as Schema from 'effect/Schema'

/**
 * A row this agent wrote does not read back as what it wrote. It is the agent's fault, never the caller's: it reaches
 * the owner as `Internal` and is reported with its stack locations (ADR 0024). `what` names the data, never its value.
 */
export class StoredDataInvalid extends Schema.TaggedError<StoredDataInvalid>()('StoredDataInvalid', {
  what: Schema.String,
}) {}
