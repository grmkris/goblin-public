import { Schema } from 'effect'
import type { SourceEvent } from './schema.ts'
import { validateEvents } from './fixtures.ts'

const Record = Schema.Struct({
  type: Schema.String,
  uuid: Schema.optional(Schema.String),
  parentUuid: Schema.optional(Schema.NullOr(Schema.String)),
  timestamp: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  isCompactSummary: Schema.optional(Schema.Boolean),
  subtype: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      content: Schema.Unknown,
    }),
  ),
})
const Block = Schema.Struct({ type: Schema.String })
const Text = Schema.Struct({ type: Schema.Literal('text'), text: Schema.String })
const Call = Schema.Struct({
  type: Schema.Literal('tool_use'),
  id: Schema.String,
  name: Schema.String,
  input: Schema.JsonObject,
})
const Result = Schema.Struct({
  type: Schema.Literal('tool_result'),
  tool_use_id: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
  is_error: Schema.optional(Schema.Boolean),
})
export type Omission = { readonly line: number; readonly block?: number; readonly reason: string }
const decode = Schema.decodeUnknownSync

function visibleResult(content: (typeof Result.Type)['content'], line: number, omissions: Omission[]): string {
  if (typeof content === 'string') return content
  return content
    .flatMap((raw, block) => {
      const item = decode(Block)(raw)
      if (item.type === 'text') return decode(Text)(raw).text
      omissions.push({ line, block, reason: `tool result ${item.type} omitted` })
      return []
    })
    .join('\n')
}

type ImportState = {
  readonly events: SourceEvent[]
  readonly omissions: Omission[]
  readonly boundaries: number[]
  readonly names: Map<string, string>
  readonly uuids: Set<string>
  readonly redact: (text: string) => string
}

function importBlock(state: ImportState, record: typeof Record.Type, line: number, block: number, raw: unknown) {
  const item = decode(Block)(raw)
  const common = {
    id: `claude.l${line}.b${block}`,
    timestamp: Date.parse(record.timestamp ?? ''),
    groupId: record.message?.id ?? record.uuid,
    provenance: { line, block, uuid: record.uuid ?? '', parentUuid: record.parentUuid ?? null },
  }
  switch (item.type) {
    case 'text': {
      const text = state.redact(decode(Text)(raw).text)
      if (text !== '') state.events.push({ ...common, kind: record.type === 'user' ? 'user' : 'assistant', text })
      return
    }
    case 'tool_use': {
      const call = decode(Call)(raw)
      if (record.type !== 'assistant' || state.names.has(call.id)) throw new Error(`Invalid tool call at line ${line}`)
      state.names.set(call.id, call.name)
      const args = decode(Schema.JsonObject)(JSON.parse(state.redact(JSON.stringify(call.input))))
      state.events.push({
        ...common,
        kind: 'tool-call',
        callId: call.id,
        toolName: call.name,
        arguments: args,
        text: JSON.stringify(args),
      })
      return
    }
    case 'tool_result': {
      const result = decode(Result)(raw)
      const toolName = state.names.get(result.tool_use_id)
      if (record.type !== 'user' || toolName === undefined) throw new Error(`Invalid tool result at line ${line}`)
      state.events.push({
        ...common,
        kind: 'tool-result',
        callId: result.tool_use_id,
        toolName,
        text: state.redact(visibleResult(result.content, line, state.omissions)),
        isError: result.is_error ?? false,
      })
      return
    }
    case 'thinking':
    case 'redacted_thinking':
    case 'image':
      state.omissions.push({ line, block, reason: `${item.type} omitted` })
      return
    default:
      throw new Error(`Unsupported visible block ${item.type} at line ${line}`)
  }
}

function importRecord(state: ImportState, text: string, line: number) {
  const record = decode(Record)(JSON.parse(text))
  if (record.isSidechain === true) throw new Error(`Sidechain requires explicit lineage selection at line ${line}`)
  if (record.subtype === 'compact_boundary') state.boundaries.push(line)
  if (!['user', 'assistant'].includes(record.type) || record.isCompactSummary === true) {
    state.omissions.push({
      line,
      reason: record.isCompactSummary === true ? 'duplicate compact summary' : `metadata ${record.type}`,
    })
    return
  }
  if (
    record.uuid === undefined ||
    state.uuids.has(record.uuid) ||
    record.message === undefined ||
    record.timestamp === undefined
  )
    throw new Error(`Invalid visible record at line ${line}`)
  state.uuids.add(record.uuid)
  if (!Number.isFinite(Date.parse(record.timestamp))) throw new Error(`Invalid timestamp at line ${line}`)
  const content = record.message.content
  const blocks =
    typeof content === 'string' ? [{ type: 'text', text: content }] : decode(Schema.Array(Schema.Unknown))(content)
  blocks.forEach((raw, block) => importBlock(state, record, line, block, raw))
}

/** Claude emits separate streamed content blocks. Keep every visible block once, in file order. */
export function importClaude(source: string, redact: (text: string) => string) {
  const state: ImportState = { events: [], omissions: [], boundaries: [], names: new Map(), uuids: new Set(), redact }
  const lines = source.split('\n')
  if (lines.at(-1) === '') lines.pop()
  lines.forEach((text, at) => importRecord(state, text, at + 1))
  const errors = validateEvents(state.events)
  if (errors.length > 0) throw new Error(errors.join('; '))
  return { events: state.events, omissions: state.omissions, boundaries: state.boundaries, lines: lines.length }
}

/** Estimated source pressure uses UTF-8 bytes / 4; cutoffs never split an assistant group or leave calls open. */
export function sourceCheckpoints(events: readonly SourceEvent[], targets: readonly number[]) {
  const checkpoints: { target: number; cutoff: number; estimatedTokens: number; line: number }[] = []
  const open = new Set<string>()
  let estimatedTokens = 0
  for (const [at, event] of events.entries()) {
    estimatedTokens += Math.ceil(new TextEncoder().encode(event.text).length / 4)
    if (event.kind === 'tool-call' && event.callId !== undefined) open.add(event.callId)
    if (event.kind === 'tool-result' && event.callId !== undefined) open.delete(event.callId)
    const next = events[at + 1]
    const boundary =
      open.size === 0 && ['assistant', 'tool-result'].includes(event.kind) && event.groupId !== next?.groupId
    const target = targets[checkpoints.length]
    if (boundary && target !== undefined && estimatedTokens >= target)
      checkpoints.push({ target, cutoff: at + 1, estimatedTokens, line: event.provenance?.line ?? 0 })
  }
  if (checkpoints.length !== targets.length) throw new Error('Source lacks complete requested checkpoints')
  return checkpoints
}
