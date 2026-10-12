// The committed messages of a conversation as the transcript reads them, projected from Pi's messages: the owner's,
// the assistant's (with its tool calls, thinking, usage and why it has no answer) and tool results.
import type {
  Attachment,
  ComposerOption,
  DelegateResultData,
  NoticeData,
  PersonaAnswerData,
  PersonaAskData,
  ThreadHeadData,
  TopicSeedData,
  McpOutcome,
} from '@goblin/contracts'
import { type SharedContext, sharedContext } from './app-context.ts'
import { identifier, isNumber, isString, record, records, text } from './values.ts'

/** A tool call the assistant made, with its raw arguments. */
export type ToolCallView = { readonly id: string; readonly name: string; readonly arguments: Record<string, unknown> }
/** The tokens one model response used, as Pi records them (cost is not tracked: the catalog prices are zero). */
export type TokenUsage = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly totalTokens: number
}
/**
 * Committed conversation messages, projected from Pi entries. `timestamp` (epoch ms) is Pi's, when the message has
 * one; optional fields are absent rather than empty.
 */
export type ChatMessage =
  | {
      readonly id: string
      readonly role: 'user'
      readonly text: string
      /** What an open App shared with this message, labelled untrusted for the agent. */
      readonly context?: readonly SharedContext[]
      /** The owner's files this message carried. */
      readonly attachments?: readonly Attachment[]
      readonly selections?: readonly ComposerOption[]
      /** Who wrote it, when not the owner in this browser: Telegram, an MCP client, a subagent. */
      readonly author?: string
      /** How a held call ended, when this is its outcome (from its connection). */
      readonly outcome?: McpOutcome
      /** The thread a note shared into main came from. */
      readonly thread?: string
      /** The Personas the owner asked instead of Goblin (`app.persona_ask`), and in what order. */
      readonly ask?: PersonaAskData
      readonly timestamp?: number
    }
  | {
      readonly id: string
      readonly role: 'assistant'
      readonly text: string
      readonly toolCalls: readonly ToolCallView[]
      /** The model's visible thinking, when it emitted any (redacted thinking is left out). */
      readonly reasoning?: string
      readonly usage?: TokenUsage
      readonly timestamp?: number
      /** Why this turn has no answer: the model call failed, was stopped, or came back empty. */
      readonly failure?: TurnFailure
    }
  | {
      readonly id: string
      readonly role: 'tool'
      readonly text: string
      readonly toolCallId: string
      readonly toolName: string
      readonly isError: boolean
      readonly details: unknown
      readonly timestamp?: number
    }
  /** A thread the owner started with "+": main's note naming it, shown as a row rather than a message. */
  | { readonly id: string; readonly role: 'thread-started'; readonly thread: string; readonly timestamp?: number }
  /** A Thread that started here (`app.thread_head`): its head message, shown with the Thread's replies under it. */
  | { readonly id: string; readonly role: 'thread-head'; readonly head: ThreadHeadData; readonly timestamp?: number }
  /** A Persona's attributed answer (`app.persona`). */
  | { readonly id: string; readonly role: 'persona'; readonly answer: PersonaAnswerData; readonly timestamp?: number }
  /** The brief and frozen sources a Topic made from a discussion starts with (`app.topic_seed`). */
  | { readonly id: string; readonly role: 'topic-seed'; readonly seed: TopicSeedData; readonly timestamp?: number }
  /** A routine's notice (ADR 0041): who it is from and what it says, the producer's words. */
  | { readonly id: string; readonly role: 'notice'; readonly notice: NoticeData; readonly timestamp?: number }
  /** A Delegate's attributed result, in the chat that assigned it (`app.delegate_result`). */
  | {
      readonly id: string
      readonly role: 'delegate-result'
      readonly result: DelegateResultData
      readonly timestamp?: number
    }
/**
 * Why a turn has no answer, or no whole one. `provider`: the model's provider refused or is down, so another model may
 * answer. `stopped`: the owner stopped it, which is a choice rather than a failure. `cutOff`: the answer reached the
 * output limit, so what came before it stands and the agent can continue.
 */
export type TurnFailure = {
  readonly text: string
  readonly provider: boolean
  readonly stopped?: true
  readonly cutOff?: true
}

/** The provider's raw error, in a sentence the owner can act on; the first line of anything unrecognised. */
export function failureReason(raw: string): TurnFailure {
  if (/\b429\b|quota|rate.?limit|too many requests/iu.test(raw))
    return { text: 'The model provider refused the request: quota exceeded or rate-limited.', provider: true }
  if (/\b(?:500|502|503|504)\b|overloaded|high demand|unavailable/iu.test(raw))
    return { text: 'The model provider is overloaded or unavailable.', provider: true }
  // The router answers 404 when it cannot reach the model right now (Meta's model went missing for minutes at a time).
  if (/\b404\b|model_not_found|NotFoundError|model[^\n]{0,40}not found/iu.test(raw))
    return {
      text: "This model isn't available right now. Pick another model below and send again.",
      provider: true,
    }
  const line =
    raw
      .split('\n')
      .find((part) => part.trim() !== '')
      ?.trim() ?? ''
  return {
    text: line === '' ? 'The model call failed.' : `The model call failed: ${line.slice(0, 200)}`,
    provider: false,
  }
}

/** A turn that ended without an answer, or was cut short, says why instead of rendering nothing. */
function assistantFailure(
  message: Record<string, unknown>,
  content: string,
  calls: readonly ToolCallView[],
): TurnFailure | undefined {
  if (message.stopReason === 'error') return failureReason(isString(message.errorMessage) ? message.errorMessage : '')
  if (message.stopReason === 'aborted') return { text: 'Stopped before answering.', provider: false, stopped: true }
  if (message.stopReason === 'length')
    return { text: 'Cut off at the output limit. Ask it to continue.', provider: false, cutOff: true }
  if (content === '' && calls.length === 0 && message.stopReason === 'stop')
    return { text: 'The model returned an empty answer.', provider: false }
  return undefined
}

/** The visible thinking in content blocks; redacted thinking is an opaque payload, not text for the owner. */
export function reasoningText(blocks: unknown): string {
  return records(blocks)
    .filter((block) => block.type === 'thinking' && block.redacted !== true && isString(block.thinking))
    .map((block) => text(block.thinking).trim())
    .filter((thought) => thought !== '')
    .join('\n\n')
}

const count = (value: unknown): number => (isNumber(value) && Number.isFinite(value) ? value : 0)
function tokenUsage(value: unknown): TokenUsage | undefined {
  const usage = record(value)
  if (usage === undefined) return undefined
  return {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    totalTokens: count(usage.totalTokens),
  }
}
/** The message's own timestamp (epoch ms), as a field to spread, when it has one. */
export const stamped = (message: Record<string, unknown>) =>
  isNumber(message.timestamp) && Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}

function assistantMessage(message: Record<string, unknown>, id: string, content: string): ChatMessage {
  const toolCalls = records(message.content)
    .filter((block) => block.type === 'toolCall')
    .map((block) => ({
      id: identifier(block.id),
      name: identifier(block.name),
      arguments: record(block.arguments) ?? {},
    }))
  const failure = assistantFailure(message, content, toolCalls)
  const reasoning = reasoningText(message.content)
  const usage = tokenUsage(message.usage)
  return {
    id,
    role: 'assistant',
    text: content,
    toolCalls,
    ...(reasoning === '' ? {} : { reasoning }),
    ...(usage === undefined ? {} : { usage }),
    ...stamped(message),
    ...(failure === undefined ? {} : { failure }),
  }
}

/** The messages one of Pi's messages makes: `id` is the transcript's, `thread` the thread a shared note came from. */
export function entryMessage(message: Record<string, unknown>, id: string, thread?: string): ChatMessage[] {
  const content = text(message.content)
  if (message.role === 'toolResult')
    return [
      {
        id,
        role: 'tool',
        text: content,
        toolCallId: identifier(message.toolCallId),
        toolName: identifier(message.toolName),
        isError: message.isError === true,
        details: message.details,
        ...stamped(message),
      },
    ]
  if (message.role === 'assistant') return [assistantMessage(message, id, content)]
  if (message.role === 'user') {
    const shared = sharedContext(message.content)
    const context = shared.context.length === 0 ? {} : { context: shared.context }
    const attachments = shared.attachments === undefined ? {} : { attachments: shared.attachments }
    const selections = shared.selections === undefined ? {} : { selections: shared.selections }
    const author = shared.author === undefined ? {} : { author: shared.author }
    const outcome = shared.outcome === undefined ? {} : { outcome: shared.outcome }
    const from = thread === undefined ? {} : { thread }
    return [
      {
        id,
        role: 'user',
        text: shared.text,
        ...context,
        ...attachments,
        ...selections,
        ...author,
        ...outcome,
        ...from,
        ...stamped(message),
      },
    ]
  }
  return []
}
