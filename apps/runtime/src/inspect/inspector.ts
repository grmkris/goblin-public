import type { EntryRecord } from '@earendil-works/pi-durable'
import { authorOf } from '@goblin/contracts'
import type {
  InspectConversations,
  InspectDetails,
  InspectDetailsArguments,
  InspectDetailsInput,
  InspectEntries,
  InspectEntry,
  InspectFlows,
  InspectFlowsInput,
  InspectProblems,
  InspectQuery,
  InspectTurns,
  TurnSummary,
  TurnTimeline,
} from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import type { PiHarness } from 'agents/harness/pi'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { nowMillis } from '../clock.ts'
import type { ConversationRegistry } from '../conversations.ts'
import { InvalidInput, NotFound } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { textBlocks } from '../pi/transcript.ts'
import { flowOf } from '../telemetry/events.ts'
import type { RunLedger } from '../telemetry/ledger.ts'
import { coverageGaps } from './coverage.ts'

/** Longest text kept from one entry; the rest is cut and the entry marked `truncated`. */
const MAX_TEXT = 4000
/** Longest JSON kept for a tool call's arguments or an entry's data. */
const MAX_JSON = 2000
/** What `turns` and `problems` look back over by default. */
const DAY_MS = 24 * 60 * 60 * 1000
/** Newer than any entry: the newest page of a conversation. */
const NEWEST = 2 ** 31
/** How many flow steps `flows` answers by default. */
const FLOWS = 50

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

/** A details query's reader input: an operation, or a chat with one of its entries. Anything else is invalid. */
function detailsInput({ operation, chat, entry }: InspectDetailsArguments): InspectDetailsInput {
  if (operation !== undefined) return { operation }
  if (chat !== undefined && entry !== undefined) return { chat, entry }
  throw new InvalidInput({ reason: 'details take an operation, or a chat and an entry' })
}

/** Read-only inspection of this agent (ADR 0024): Pi for content and settlement, the run ledger for how it ran. */
export class Inspector {
  readonly #ledger: RunLedger
  readonly #registry: ConversationRegistry
  readonly #harness: PiHarness
  readonly #clock: () => number

  constructor(ledger: RunLedger, registry: ConversationRegistry, harness: PiHarness, clock: () => number = nowMillis) {
    this.#ledger = ledger
    this.#registry = registry
    this.#harness = harness
    this.#clock = clock
  }

  async run(query: InspectQuery) {
    switch (query.kind) {
      case 'conversations':
        return this.conversations()
      case 'conversation':
        return this.conversation(query.conversation, query.before)
      case 'turns':
        return this.turns(query.since, query.limit, query.conversation)
      case 'turn':
        return this.turn(query.operationId)
      case 'problems':
        return this.problems(query.since, query.limit, query.all)
      case 'flows':
        return this.flows(query)
      case 'details':
        return this.details(detailsInput(query))
    }
  }

  async conversations(): Promise<InspectConversations> {
    return { conversations: await this.#registry.list() }
  }

  /** A page of a registered conversation's entries, oldest first, ending before `before`. */
  async conversation(session: string, before = NEWEST): Promise<InspectEntries> {
    const page = await this.#registry.history(session, before)
    const first = page.entries[0]
    return {
      conversation: session,
      entries: page.entries.map(inspectEntry),
      ...(page.more && first !== undefined ? { before: Number(first.id) } : {}),
    }
  }

  turns(since?: number, limit = 20, conversation?: string): InspectTurns {
    const session = conversation === undefined ? undefined : this.#registry.require(conversation)
    const turns = this.#ledger.turns(since ?? this.#clock() - DAY_MS, limit, session)
    const events = this.#ledger.forOperations(turns.flatMap((turn) => turn.operationId ?? []))
    return {
      turns: turns.map((turn) =>
        summarize(
          turn,
          events.filter((event) => event.operationId === turn.operationId),
        ),
      ),
    }
  }

  async turn(operationId: string): Promise<TurnTimeline> {
    const events = this.#ledger.forOperation(operationId)
    const turn = events.find((event) => event.kind === 'turn.submitted')
    if (turn === undefined) throw new NotFound({ what: 'turn' })
    const submission = await this.#submission(turn.conversationId, operationId)
    const gaps = coverageGaps(turn, events, submission)
    return {
      turn: summarize(turn, events),
      ...(submission === undefined ? {} : { submission }),
      events,
      coverage: { complete: gaps.length === 0, gaps },
    }
  }

  problems(since?: number, limit = 50, all = false): InspectProblems {
    const from = since ?? this.#clock() - DAY_MS
    return { since: from, problems: this.#ledger.problems(from, limit, all) }
  }

  /** Conversation flow steps since `since` (the last day by default), newest first, of one chat or flow if asked. */
  flows(input: InspectFlowsInput): InspectFlows {
    const since = input.since ?? this.#clock() - DAY_MS
    const flows = this.#ledger.flows(since, input.limit ?? FLOWS, input).flatMap((event) => {
      const step = flowOf(event)
      return step === undefined ? [] : [{ ...step, at: event.endedAt ?? event.startedAt }]
    })
    return { since, flows }
  }

  /**
   * The details behind a message. So far only an operation that ran a turn has them: its timeline, with no related
   * operations. An entry's operation, a passive write and related operations need the operation receipts, which are
   * not read yet.
   */
  async details(input: InspectDetailsInput): Promise<InspectDetails> {
    if (!('operation' in input)) throw new NotFound({ what: 'operation' })
    return { ...(await this.turn(input.operation)), related: [] }
  }

  /** Pi's own settlement of a turn: whether its submission was answered, and with which entry. */
  async #submission(conversation: string | undefined, operationId: string) {
    if (conversation === undefined) return undefined
    const pi = await this.#harness.pi()
    const record = await pi.commit(
      (tx) => tx.submissionByRequest(conversationId(conversation), operationId),
      BACKGROUND,
    )
    if (record === undefined) return undefined
    return {
      status: record.status,
      ...(record.entry === undefined ? {} : { entry: Number(record.entry) }),
      ...(record.answer === undefined ? {} : { answer: Number(record.answer) }),
      ...(record.reason === undefined ? {} : { reason: record.reason }),
    }
  }
}
