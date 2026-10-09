import type { EntryRecord, SubmissionRecord } from '@earendil-works/pi-durable'
import { authorOf } from '@goblin/contracts'
import type { FlowRecord, InspectEntry, RelatedOperation, TurnSummary, TurnTimeline } from '@goblin/contracts/inspect'
import { type FlowEvent, RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { textBlocks } from '../pi/transcript.ts'
import { flowOf } from '../telemetry/events.ts'
import type { RunLedger } from '../telemetry/ledger.ts'

/** Longest text kept from one entry; the rest is cut and the entry marked `truncated`. */
const MAX_TEXT = 4000
/** Longest JSON kept for a tool call's arguments or an entry's data. */
const MAX_JSON = 2000

const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.optional(Schema.Unknown),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.Number),
  usage: Schema.optional(Schema.Struct({ input: Schema.Number, output: Schema.Number, cacheRead: Schema.Number })),
  toolCallId: Schema.optional(Schema.String),
  toolName: Schema.optional(Schema.String),
  isError: Schema.optional(Schema.Boolean),
})
const Call = Schema.Struct({
  type: Schema.Literal('toolCall'),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.optional(Schema.Unknown),
})
const Thought = Schema.Struct({
  type: Schema.Literal('thinking'),
  thinking: Schema.String,
  redacted: Schema.optional(Schema.Boolean),
})
const decodeMessage = (value: unknown) => Option.getOrUndefined(Schema.decodeUnknownOption(Message)(value))
const isCall = Schema.is(Call)
const isThought = Schema.is(Thought)

type Cut = { readonly text: string; readonly cut: boolean }
const cut = (text: string, max: number): Cut =>
  text.length > max ? { text: `${text.slice(0, max)}…`, cut: true } : { text, cut: false }
const json = (value: unknown, max: number): Cut => cut(JSON.stringify(value ?? null), max)

/** A message's content blocks; content that is a plain string has none. */
const blocksOf = (content: unknown): readonly unknown[] => (Array.isArray(content) ? content : [])

/** The calls an answer made, each with its arguments as bounded JSON. */
function callsOf(content: unknown) {
  return blocksOf(content)
    .filter(isCall)
    .map((call) => {
      const args = json(call.arguments, MAX_JSON)
      return { call: { id: call.id, name: call.name, arguments: args.text }, cut: args.cut }
    })
}

/** An answer's visible thinking; redacted thinking is an opaque payload, not words. */
const thinkingOf = (content: unknown): string =>
  blocksOf(content)
    .filter(isThought)
    .filter((block) => block.redacted !== true && block.thinking.trim() !== '')
    .map((block) => block.thinking.trim())
    .join('\n\n')

type Message = typeof Message.Type
type MessageFields = Pick<InspectEntry, 'role' | 'author' | 'text' | 'thinking' | 'toolCalls' | 'tool' | 'model' | 'at'>

/** For a tool result: which call it answers and whether it failed. */
const toolOf = (message: Message) =>
  message.toolCallId === undefined
    ? {}
    : { tool: { callId: message.toolCallId, name: message.toolName ?? '', isError: message.isError === true } }

/** For an answer: the model, why it stopped, its error and its tokens. */
function modelOf(message: Message) {
  if (message.role !== 'assistant' || message.usage === undefined) return {}
  return {
    model: {
      provider: message.provider ?? '',
      model: message.model ?? '',
      stopReason: message.stopReason ?? '',
      ...(message.errorMessage === undefined ? {} : { error: message.errorMessage }),
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
    },
  }
}

/**
 * A message's words (an author tag becomes `author`), its thinking, calls, tool result and model, and whether any was
 * cut.
 */
function messageFields(message: Message | undefined): { readonly fields: MessageFields; readonly cut: boolean } {
  if (message === undefined) return { fields: {}, cut: false }
  const blocks = textBlocks(message.content)
  const author = message.role === 'user' && blocks.length > 1 ? authorOf(blocks[0] ?? '') : undefined
  const words = cut((author === undefined ? blocks : blocks.slice(1)).join('\n'), MAX_TEXT)
  const thinking = cut(thinkingOf(message.content), MAX_TEXT)
  const calls = callsOf(message.content)
  return {
    fields: {
      role: message.role,
      ...(author === undefined ? {} : { author }),
      ...(words.text === '' ? {} : { text: words.text }),
      ...(thinking.text === '' ? {} : { thinking: thinking.text }),
      ...(calls.length === 0 ? {} : { toolCalls: calls.map((call) => call.call) }),
      ...toolOf(message),
      ...modelOf(message),
      ...(message.timestamp === undefined ? {} : { at: message.timestamp }),
    },
    cut: words.cut || thinking.cut || calls.some((call) => call.cut),
  }
}

/** One Pi entry for a reader: its message as {@link messageFields}, or Pi's own data when it has none. */
export function inspectEntry(entry: EntryRecord): InspectEntry {
  const message = messageFields(decodeMessage(entry.model?.[0]))
  const data = entry.model === undefined && entry.data !== undefined ? json(entry.data, MAX_JSON) : undefined
  const truncated = message.cut || data?.cut === true
  return {
    id: Number(entry.id),
    kind: entry.kind,
    ...message.fields,
    ...(data === undefined ? {} : { data: data.text }),
    ...(entry.byTaskId === undefined ? {} : { task: String(entry.byTaskId) }),
    ...(truncated ? { truncated } : {}),
  }
}

const numberOf = (event: RunEvent, key: string): number => {
  const value = event.attributes[key]
  return typeof value === 'number' ? value : 0
}
const stringOf = (event: RunEvent, key: string): string | undefined => {
  const value = event.attributes[key]
  return typeof value === 'string' ? value : undefined
}
const failed = (event: RunEvent) => event.status !== 'ok' && event.status !== 'started'

/** A turn in a line, from its own event and the events that share its operation id. */
export function summarize(turn: RunEvent, events: readonly RunEvent[]): TurnSummary {
  const attempts = events.filter((event) => event.kind === 'model.attempt')
  const tools = events.filter((event) => event.kind === 'tool.call')
  const errors = events.filter((event) => event.kind === 'error')
  const reason = stringOf(turn, RunAttribute.reason)
  return {
    operationId: turn.operationId ?? turn.id,
    ...(turn.conversationId === undefined ? {} : { conversationId: turn.conversationId }),
    source: stringOf(turn, RunAttribute.source) ?? 'direct',
    status: turn.status,
    ...(reason === undefined ? {} : { reason }),
    startedAt: turn.startedAt,
    ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
    modelAttempts: attempts.length,
    failedAttempts: attempts.filter(failed).length,
    toolCalls: tools.length,
    failedToolCalls: tools.filter(failed).length,
    inputTokens: attempts.reduce((sum, event) => sum + numberOf(event, RunAttribute.inputTokens), 0),
    outputTokens: attempts.reduce((sum, event) => sum + numberOf(event, RunAttribute.outputTokens), 0),
    errors: errors.length,
  }
}

/** The operations whose own ids derive from another's: a Persona's answer to it, and a Thread's first send. */
const PERSONA_ANSWER = /^persona:(.+):\d+$/u
const FIRST_SEND = /^(.+):first$/u
/** At most this many related operations in one read. */
const RELATED = 20

type LinkReads = Pick<RunLedger, 'forOperations' | 'childFlows' | 'operationsStarting'>

/**
 * The operations linked to `operationId`, with the kind each is by its id alone: its parent and the operations it
 * caused, by the flow graph (`goblin.operation.parent`) and, for rows older than flow events, by the ids derived from it
 * (a Persona's answer `persona:<operation>:<persona>`, a Thread's first send `<operation>:first`).
 */
function linksOf(ledger: LinkReads, operationId: string, events: readonly RunEvent[]): Map<string, string> {
  const links = new Map<string, string>()
  const add = (operation: string | undefined, kind: string) => {
    if (operation === undefined || operation === operationId || operation.length > 200 || links.has(operation)) return
    links.set(operation, kind)
  }
  for (const event of events) add(flowOf(event)?.parentOperation, 'operation')
  add(PERSONA_ANSWER.exec(operationId)?.[1], 'persona_ask')
  add(FIRST_SEND.exec(operationId)?.[1], 'start')
  for (const child of ledger.childFlows(operationId)) add(child.operationId, flowOf(child)?.flow ?? 'operation')
  for (const answer of ledger.operationsStarting(`persona:${operationId}:`)) add(answer, 'persona_answer')
  const first = `${operationId}:first`
  if (ledger.operationsStarting(first).includes(first)) add(first, 'send')
  return links
}

/**
 * The operations linked to `operationId` (`linksOf`), nearest first, each described by its newest flow step when it
 * has one: which flow, its chat and how it ended. `events` are the operation's own.
 */
export function relatedOf(ledger: LinkReads, operationId: string, events: readonly RunEvent[]): RelatedOperation[] {
  const linked = [...linksOf(ledger, operationId, events)].slice(0, RELATED)
  const flows = new Map<string, FlowEvent>()
  for (const event of ledger.forOperations(linked.map(([operation]) => operation))) {
    const flow = flowOf(event)
    if (flow?.operationId !== undefined) flows.set(flow.operationId, flow)
  }
  return linked.map(([operation, kind]) => {
    const flow = flows.get(operation)
    if (flow === undefined) return { operation, kind }
    return { operation, kind: flow.flow, ...(flow.chat === undefined ? {} : { chat: flow.chat }), state: flow.status }
  })
}

/** Pi's settlement of a submission, as a timeline shows it. */
export function settlementOf(record: SubmissionRecord | undefined): TurnTimeline['submission'] {
  if (record === undefined) return undefined
  return {
    status: record.status,
    ...(record.entry === undefined ? {} : { entry: Number(record.entry) }),
    ...(record.answer === undefined ? {} : { answer: Number(record.answer) }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  }
}

/** A flow step as `inspect_flows` lists it, or nothing for an event that is no flow step. */
export function flowRecord(event: RunEvent): FlowRecord | undefined {
  const step = flowOf(event)
  return step === undefined ? undefined : { ...step, at: event.endedAt ?? event.startedAt }
}
