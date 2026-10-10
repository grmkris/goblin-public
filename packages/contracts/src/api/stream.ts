import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'

/** A body of server-sent events, as the browser's `EventSource` reads it: the agent writes it, never JSON. */
export const EventStream = HttpApiSchema.StreamUint8Array({ contentType: 'text/event-stream' })

/** A body of bytes as stored, whatever their type: its own `content-type` says what they are. */
export const Bytes = HttpApiSchema.StreamUint8Array()
