import { Schema } from 'effect'
import type { SourceEvent } from './schema.ts'
import { validateEvents } from './fixtures.ts'
import type { Omission } from './import.ts'

const NullableText = Schema.NullOr(Schema.String)
const Message = Schema.Struct({
  id: Schema.Int,
  role: Schema.String,
  content: NullableText,
  tool_call_id: NullableText,
  tool_calls: NullableText,
  tool_name: NullableText,
  timestamp: Schema.Number,
  finish_reason: NullableText,
  display_kind: NullableText,
  active: Schema.Int,
  compacted: Schema.Int,
})
export const HermesExport = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionHash: Schema.String,
  source: Schema.Literal('telegram'),
  chatType: Schema.Literal('dm'),
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  parentSessionHash: Schema.Null,
  privateIdentifiers: Schema.Array(Schema.String),
  messages: Schema.Array(Message),
})
const Calls = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    type: Schema.Literal('function'),
    function: Schema.Struct({ name: Schema.String, arguments: Schema.Union([Schema.String, Schema.JsonObject]) }),
  }),
)

type State = {
  readonly events: SourceEvent[]
  readonly omissions: Omission[]
  readonly names: Map<string, string>
  readonly redact: (text: string) => string
  readonly originals: Map<string, typeof Message.Type>
  readonly results: Set<string>
  copying: boolean
}
const origin = (message: typeof Message.Type, line: number) => ({
  timestamp: message.timestamp * 1000,
  groupId: `hermes.m${message.id}`,
  provenance: { line, block: 0, uuid: String(message.id), parentUuid: null },
})
function importCalls(state: State, message: typeof Message.Type, line: number) {
  if (message.tool_calls === null) return
  if (message.role !== 'assistant') throw new Error(`Non-assistant Hermes calls at row ${line}`)
  const calls = Schema.decodeUnknownSync(Calls)(JSON.parse(message.tool_calls))
  for (const [block, call] of calls.entries()) {
    if (state.names.has(call.id)) throw new Error(`Duplicate Hermes call at row ${line}`)
    state.names.set(call.id, call.function.name)
    const raw =
      typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments)
    const args = Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(state.redact(raw)))
    const common = origin(message, line)
    state.events.push({
      ...common,
      provenance: { ...common.provenance, block: block + 1 },
      id: `hermes.m${message.id}.call${block}`,
      kind: 'tool-call',
      callId: call.id,
      toolName: call.function.name,
      arguments: args,
      text: JSON.stringify(args),
    })
  }
}
function importResult(state: State, message: typeof Message.Type, line: number) {
  const toolName = state.names.get(message.tool_call_id ?? '')
  if (toolName === undefined) throw new Error(`Unmatched Hermes tool result at row ${line}`)
  state.events.push({
    ...origin(message, line),
    id: `hermes.m${message.id}.result`,
    kind: 'tool-result',
    callId: message.tool_call_id ?? '',
    toolName: message.tool_name ?? toolName,
    text: state.redact(message.content ?? ''),
    isError: toolFailure(message),
  })
}
function toolFailure(message: typeof Message.Type): boolean | undefined {
  if (message.finish_reason === 'error') return true
  try {
    const value: unknown = JSON.parse(message.content ?? '')
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        is_error: Schema.optional(Schema.Boolean),
        success: Schema.optional(Schema.Boolean),
        error: Schema.optional(Schema.Unknown),
      }),
    )(value)
    if (result.is_error !== undefined) return result.is_error
    if (result.success !== undefined) return !result.success
    if (result.error !== undefined && result.error !== null) return true
  } catch {
    /* Non-JSON tool text has no structured error flag; preserve unknown rather than infer success. */
  }
  return undefined
}
function importMessage(state: State, message: typeof Message.Type, line: number) {
  if (message.role === 'session_meta') state.copying = true
  if (message.active === 0 && message.compacted === 0) {
    state.omissions.push({ line, reason: 'rewound original' })
    return
  }
  if (compressionCopy(state, message)) {
    state.omissions.push({ line, reason: 'compression replay copy; original retained' })
    return
  }
  if (!['user', 'assistant', 'tool'].includes(message.role) || message.display_kind === 'hidden') {
    state.omissions.push({
      line,
      reason: message.display_kind === 'hidden' ? 'hidden assistant' : `metadata ${message.role}`,
    })
    return
  }
  if (message.display_kind !== null) throw new Error(`Unsupported Hermes display kind at row ${line}`)
  if (message.role === 'tool') {
    importResult(state, message, line)
    state.results.add(message.tool_call_id ?? '')
    return
  }
  if (message.content)
    state.events.push({
      ...origin(message, line),
      id: `hermes.m${message.id}.text`,
      kind: message.role === 'user' ? 'user' : 'assistant',
      text: state.redact(message.content),
    })
  importCalls(state, message, line)
  state.originals.set(messageKey(message), message)
}
const messageKey = (message: typeof Message.Type) =>
  JSON.stringify([message.role, message.content, message.role === 'user' ? message.timestamp : null])
function compressionCopy(state: State, message: typeof Message.Type): boolean {
  if (message.role === 'tool') return state.results.has(message.tool_call_id ?? '')
  if (message.tool_calls !== null) {
    const calls = Schema.decodeUnknownSync(Calls)(JSON.parse(message.tool_calls))
    const copied = calls.length > 0 && calls.every((call) => state.names.has(call.id))
    if (copied) state.copying = true
    return copied
  }
  const original = state.originals.get(messageKey(message))
  if (original?.compacted === 1 && (message.role === 'user' || state.copying)) {
    state.copying = true
    return true
  }
  if (message.role === 'user') state.copying = false
  return false
}
/** Read original visible records, including compacted/inactive originals. Never import API/reasoning fields. */
export function importHermes(source: string, redact: (text: string) => string) {
  const snapshot = Schema.decodeUnknownSync(HermesExport)(JSON.parse(source))
  const state: State = {
    events: [],
    omissions: [],
    names: new Map(),
    redact,
    originals: new Map(),
    results: new Set(),
    copying: false,
  }
  let previousId = -1
  for (const [at, message] of snapshot.messages.entries()) {
    if (message.id <= previousId) throw new Error('Hermes snapshot must preserve unique ascending message IDs')
    previousId = message.id
    importMessage(state, message, at + 1)
  }
  const errors = validateEvents(state.events)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return { events: state.events, omissions: state.omissions, boundaries: [], lines: snapshot.messages.length }
}
