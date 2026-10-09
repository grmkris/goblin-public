import {
  type Attachment,
  type ComposerOption,
  type PersonaAnswerData,
  type PersonaTag,
  TELEGRAM_AUTHOR,
  type TopicSeedData,
} from '@goblin/contracts'
import type { SharedContext } from './app-context.ts'
import { isString, record } from './values.ts'
import type { ChatMessage, ConversationProjection, LiveTool, ToolCallView, TurnFailure } from './projection.ts'

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>
type ToolResultMessage = Extract<ChatMessage, { role: 'tool' }>

/**
 * Where a tool call is in its life. `pending`: the model asked for it and the run has not started it yet. `running`:
 * executing (or finished, with the result not committed yet). `stopped`: the turn ended before it ran.
 */
export type ToolState = 'pending' | 'running' | 'done' | 'error' | 'stopped'
/** The MCP server, tool and arguments behind an `mcp_call`. */
export type McpTarget = {
  readonly serverId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}
/**
 * What an `app_build` call made active: the app, its version, whether it has a view, and whether this call is where
 * the transcript shows that view (the newest such build of the app; ADR 0021).
 */
export type AppBuilt = {
  readonly app: string
  readonly version: number
  readonly ui: boolean
  readonly place: boolean
  /** The app's title, when the build waits for the owner to allow powers it asks for. */
  readonly asks?: string
}
/** One tool call with its result folded in. Times are epoch ms: started from the live start or the asking message. */
export type ToolPart = {
  readonly kind: 'tool'
  readonly id: string
  readonly call: ToolCallView
  readonly target?: McpTarget
  readonly result?: ToolResultMessage
  readonly state: ToolState
  readonly startedAt?: number
  readonly endedAt?: number
  readonly built?: AppBuilt
}
/** What the transcript renders, in order. Every part has a stable id for the scroller. */
export type Part =
  | {
      readonly kind: 'user'
      readonly id: string
      readonly text: string
      readonly context?: readonly SharedContext[]
      readonly attachments?: readonly Attachment[]
      readonly selections?: readonly ComposerOption[]
      readonly author?: string
      /** The thread a note shared into main came from. */
      readonly thread?: string
      /** When it was written (epoch ms), where Pi knows. */
      readonly at?: number
    }
  | {
      readonly kind: 'reasoning'
      readonly id: string
      readonly key?: string
      readonly text: string
      readonly live: boolean
    }
  | { readonly kind: 'text'; readonly id: string; readonly key?: string; readonly text: string; readonly live: boolean }
  | ToolPart
  | { readonly kind: 'failure'; readonly id: string; readonly failure: TurnFailure }
  /** A thread the owner started with "+", where main noted it. */
  | { readonly kind: 'thread-started'; readonly id: string; readonly thread: string }
  /**
   * The head of a Thread started here (from the composer, or a turn moved out to it): the message, who wrote it, and
   * the Thread its replies are in. `moved`: the turn was moved out of this chat, which keeps only this head.
   */
  | {
      readonly kind: 'thread-head'
      readonly id: string
      readonly thread: string
      readonly text: string
      readonly author?: string
      readonly moved: boolean
      readonly at?: number
    }
  /** The owner's message to Personas instead of Goblin: their words, and whom they asked, together or in order. */
  | {
      readonly kind: 'persona-ask'
      readonly id: string
      readonly text: string
      readonly personas: readonly (typeof PersonaTag)['Type'][]
      readonly order: 'parallel' | 'sequence'
      readonly attachments?: readonly Attachment[]
      readonly at?: number
    }
  /** One Persona's attributed answer. */
  | ({ readonly kind: 'persona-answer'; readonly id: string; readonly at?: number } & Omit<
      PersonaAnswerData,
      'operationId'
    >)
  /** The brief and frozen sources a Topic made from a discussion starts with. */
  | ({ readonly kind: 'topic-seed'; readonly id: string } & TopicSeedData)
  /** A Delegate's result posted back here: who did it, how it ended, and its report. */
  | {
      readonly kind: 'delegate-result'
      readonly id: string
      readonly delegate: string
      readonly name: string
      readonly status: 'done' | 'failed' | 'stopped'
      readonly text: string
      readonly at?: number
    }

/** The parts drawn from an entry of the app's own (a thread head, a Persona's answer…), which never change once written. */
const DRAWN = new Set<Part['kind']>(['thread-head', 'persona-ask', 'persona-answer', 'topic-seed', 'delegate-result'])

/**
 * A turn the owner took: words typed in this app or sent from Telegram. Messages from an MCP client, a subagent's
 * report, a routine's note and a thread's share-back carry another author and are not turns. In a subagent's or a
 * routine's own conversation the message that starts each run has no author, so it is that conversation's turn.
 */
export function isOwnTurn(part: Part): part is Extract<Part, { readonly kind: 'user' | 'persona-ask' }> {
  if (part.kind === 'persona-ask') return true
  return part.kind === 'user' && (part.author === undefined || part.author === TELEGRAM_AUTHOR)
}

/** An object, or the JSON string of one, which the model may send for a free-form argument (ADR 0027). */
function objectArgument(value: unknown): Record<string, unknown> | undefined {
  if (!isString(value)) return record(value)
  try {
    return record(JSON.parse(value))
  } catch {
    // expected: a free-form argument that is not JSON is no object, and the call shows without one
    return undefined
  }
}

/** The MCP server, tool and arguments of an `mcp_call`, when the call has that shape. */
export function mcpTarget(call: ToolCallView): McpTarget | undefined {
  if (call.name !== 'mcp_call') return undefined
  const { serverId, name } = call.arguments
  if (!isString(serverId) || !isString(name)) return undefined
  return { serverId, name, arguments: objectArgument(call.arguments.arguments) ?? {} }
}

function toolState(result: ToolResultMessage | undefined, live: LiveTool | undefined, running: boolean): ToolState {
  if (result !== undefined) return result.isError ? 'error' : 'done'
  if (live !== undefined) return 'running'
  return running ? 'pending' : 'stopped'
}

type Context = {
  readonly results: ReadonlyMap<string, ToolResultMessage>
  readonly live: ReadonlyMap<string, LiveTool>
  readonly running: boolean
}

function toolPart(call: ToolCallView, context: Context, askedAt: number | undefined): ToolPart {
  const result = context.results.get(call.id)
  const live = context.live.get(call.id)
  const target = mcpTarget(call)
  const startedAt = live?.startedAt ?? askedAt
  return {
    kind: 'tool',
    id: `tool:${call.id}`,
    call,
    ...(target === undefined ? {} : { target }),
    ...(result === undefined ? {} : { result }),
    state: toolState(result, live, context.running),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(result?.timestamp === undefined ? {} : { endedAt: result.timestamp }),
  }
}

/**
 * The React key of a message's thinking or text row: from when the message started, which it has while it streams and
 * after it commits, so the row is not remounted when its id changes at the commit (`partial:*` → `<entry>:*`).
 */
const keyed = (at: number | undefined, row: 'reasoning' | 'text') =>
  at === undefined ? {} : { key: `at:${at}:${row}` }

function assistantParts(message: AssistantMessage, context: Context): Part[] {
  const parts: Part[] = []
  const at = message.timestamp
  if (message.reasoning !== undefined)
    parts.push({
      kind: 'reasoning',
      id: `${message.id}:reasoning`,
      ...keyed(at, 'reasoning'),
      text: message.reasoning,
      live: false,
    })
  if (message.text !== '')
    parts.push({ kind: 'text', id: `${message.id}:text`, ...keyed(at, 'text'), text: message.text, live: false })
  for (const call of message.toolCalls) parts.push(toolPart(call, context, message.timestamp))
  if (message.failure !== undefined)
    parts.push({ kind: 'failure', id: `${message.id}:failure`, failure: message.failure })
  return parts
}

/** The in-flight turn: tools whose asking message is not committed yet, then the streaming thinking and text. */
function liveParts(projection: ConversationProjection, context: Context, seen: ReadonlySet<string>): Part[] {
  const parts: Part[] = projection.tools
    .filter((tool) => !seen.has(tool.callId))
    .map((tool) => toolPart({ id: tool.callId, name: tool.name, arguments: tool.args }, context, tool.startedAt))
  const at = projection.partialAt
  if (projection.partialReasoning !== '')
    parts.push({
      kind: 'reasoning',
      id: 'partial:reasoning',
      ...keyed(at, 'reasoning'),
      text: projection.partialReasoning,
      live: true,
    })
  if (projection.partial !== '')
    parts.push({ kind: 'text', id: 'partial:text', ...keyed(at, 'text'), text: projection.partial, live: true })
  return parts
}

/** A message in the user column, with who wrote it and when, where those are known. */
function userPart(message: Extract<ChatMessage, { role: 'user' }>): Part {
  if (message.ask !== undefined)
    return {
      kind: 'persona-ask',
      id: message.id,
      text: message.text,
      personas: message.ask.personas,
      order: message.ask.order,
      ...(message.attachments && { attachments: message.attachments }),
      ...(message.timestamp !== undefined && { at: message.timestamp }),
    }
  return {
    kind: 'user',
    id: message.id,
    text: message.text,
    ...(message.context && { context: message.context }),
    ...(message.attachments && { attachments: message.attachments }),
    ...(message.selections && { selections: message.selections }),
    ...(message.author !== undefined && { author: message.author }),
    ...(message.thread !== undefined && { thread: message.thread }),
    ...(message.timestamp !== undefined && { at: message.timestamp }),
  }
}

/** The app an `app_build` call's result says it made active, read from the result's JSON. */
export function builtApp(
  call: ToolCallView,
  result: ToolResultMessage | undefined,
): Omit<AppBuilt, 'place'> | undefined {
  if (call.name !== 'app_build' || result === undefined || result.isError) return undefined
  let value: unknown
  try {
    value = JSON.parse(result.text)
  } catch {
    // expected: a result that is not JSON is no built App, and the call shows as an ordinary tool result
    return undefined
  }
  const built = record(value)
  if (built?.status !== 'active' || !isString(built.app) || typeof built.version !== 'number') return undefined
  const title = record(built.approval)?.title
  return { app: built.app, version: built.version, ui: built.ui === true, ...(isString(title) && { asks: title }) }
}

/** Each `app_build` with what it made, and per app the newest build with a view marked as the place it shows. */
function placeApps(parts: readonly Part[]): Part[] {
  const placed = new Set<string>()
  return parts
    .toReversed()
    .map((part) => {
      const built = part.kind === 'tool' ? builtApp(part.call, part.result) : undefined
      if (part.kind !== 'tool' || built === undefined) return part
      const place = built.ui && !placed.has(built.app)
      if (place) placed.add(built.app)
      return { ...part, built: { ...built, place } }
    })
    .toReversed()
}

/** The transcript as render parts: each tool result folds into the call that asked for it. */
export function conversationParts(projection: ConversationProjection): Part[] {
  const results = new Map<string, ToolResultMessage>()
  for (const message of projection.messages) if (message.role === 'tool') results.set(message.toolCallId, message)
  const context: Context = {
    results,
    live: new Map(projection.tools.map((tool) => [tool.callId, tool])),
    running: projection.running,
  }
  const seen = new Set<string>()
  const parts: Part[] = []
  for (const message of projection.messages) {
    if (message.role === 'user') parts.push(userPart(message))
    else if (message.role === 'assistant') {
      for (const call of message.toolCalls) seen.add(call.id)
      parts.push(...assistantParts(message, context))
    } else if (message.role === 'tool') {
      // A result whose call is not in the transcript (compacted away) still shows on its own.
      if (!seen.has(message.toolCallId))
        parts.push(
          toolPart({ id: message.toolCallId, name: message.toolName, arguments: {} }, context, message.timestamp),
        )
    } else parts.push(drawnPart(message))
  }
  return uniqueKeys(placeApps([...parts, ...liveParts(projection, context, seen)]))
}

type DrawnMessage = Exclude<ChatMessage, { readonly role: 'user' | 'assistant' | 'tool' }>

/** The part of a message the app wrote itself: a thread started or its head, a Persona's answer, a seed, a result. */
function drawnPart(message: DrawnMessage): Part {
  const at = message.timestamp === undefined ? {} : { at: message.timestamp }
  switch (message.role) {
    case 'thread-started':
      return { kind: 'thread-started', id: message.id, thread: message.thread }
    case 'thread-head': {
      const { thread, text, author, moved } = message.head
      return {
        kind: 'thread-head',
        id: message.id,
        thread,
        text,
        moved: moved === true,
        ...(author && { author }),
        ...at,
      }
    }
    case 'persona': {
      const { operationId: _operation, ...answer } = message.answer
      return { kind: 'persona-answer', id: message.id, ...answer, ...at }
    }
    case 'topic-seed':
      return { kind: 'topic-seed', id: message.id, ...message.seed }
    case 'delegate-result':
      return { kind: 'delegate-result', id: message.id, ...message.result, ...at }
  }
}

/**
 * Whether two builds of a part draw the same thing. Every streamed batch builds every part anew, almost all of them
 * unchanged: the transcript's rows skip their render when this holds. Committed messages, results and live tool
 * arguments keep their identity across batches, so they compare by reference.
 */
export function samePart(a: Part, b: Part): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.id !== b.id) return false
  if (a.kind === 'tool') return b.kind === 'tool' && sameTool(a, b)
  if (a.kind === 'user') return b.kind === 'user' && sameUser(a, b)
  if (a.kind === 'failure') return b.kind === 'failure' && a.failure === b.failure
  if (a.kind === 'thread-started') return b.kind === 'thread-started' && a.thread === b.thread
  if (a.kind === 'text' || a.kind === 'reasoning')
    return (b.kind === 'text' || b.kind === 'reasoning') && a.text === b.text && a.live === b.live
  // An entry the app wrote itself never changes: the same id draws the same thing.
  return DRAWN.has(a.kind)
}

type UserPart = Extract<Part, { kind: 'user' }>
const sameUser = (a: UserPart, b: UserPart) =>
  a.text === b.text &&
  a.context === b.context &&
  a.attachments === b.attachments &&
  a.selections === b.selections &&
  a.author === b.author &&
  a.thread === b.thread &&
  a.at === b.at

const sameTool = (a: ToolPart, b: ToolPart) =>
  a.state === b.state &&
  a.result === b.result &&
  a.startedAt === b.startedAt &&
  a.endedAt === b.endedAt &&
  a.call.id === b.call.id &&
  a.call.name === b.call.name &&
  a.call.arguments === b.call.arguments &&
  sameBuilt(a.built, b.built)

const sameBuilt = (a: AppBuilt | undefined, b: AppBuilt | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.app === b.app &&
    a.version === b.version &&
    a.ui === b.ui &&
    a.place === b.place &&
    a.asks === b.asks)

/** The React key of a part: its own when it has one, else its id. */
export const partKey = (part: Part): string => ('key' in part && part.key !== undefined ? part.key : part.id)

/** Two messages that started in the same millisecond would share a key: then each falls back to its id. */
function uniqueKeys(parts: Part[]): Part[] {
  const counts = new Map<string, number>()
  for (const part of parts) counts.set(partKey(part), (counts.get(partKey(part)) ?? 0) + 1)
  return parts.map((part) =>
    (part.kind === 'reasoning' || part.kind === 'text') && part.key !== undefined && (counts.get(part.key) ?? 0) > 1
      ? { kind: part.kind, id: part.id, text: part.text, live: part.live }
      : part,
  )
}

/** The agent's own tools, in words; any other is "Used" and its name. */
const OWN_TOOLS: Readonly<Record<string, string>> = {
  mcp_list: 'Looked up its tools',
  share_back: 'Shared a note back',
  skill_activate: 'Opened a skill',
  skill_read: 'Read a skill',
}

/**
 * How a tool call reads as one line: "Used" and the server, then the tool; an `app_call` as the app and its member;
 * the agent's own tools in words.
 */
export function toolLine(part: ToolPart): { readonly lead: string; readonly server?: string; readonly tool?: string } {
  if (part.target) return { lead: 'Used', server: part.target.serverId, tool: part.target.name }
  const { app, member } = part.call.arguments
  if (part.call.name === 'app_call' && isString(app) && isString(member))
    return { lead: 'Used', server: app, tool: member }
  return { lead: OWN_TOOLS[part.call.name] ?? `Used ${part.call.name || 'a tool'}` }
}

/** How long a tool has run (to `now` while it runs) or ran; undefined when its start or end is unknown. */
export function elapsedMs(part: ToolPart, now: number): number | undefined {
  if (part.startedAt === undefined) return undefined
  const end = part.endedAt ?? (part.state === 'running' || part.state === 'pending' ? now : undefined)
  return end === undefined ? undefined : Math.max(0, end - part.startedAt)
}
