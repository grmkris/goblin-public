import { type AppContext, type Attachment, TELEGRAM_AUTHOR } from '@goblin/contracts'
import { isString, record } from './boundary.ts'
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
export type AppBuilt = { readonly app: string; readonly version: number; readonly ui: boolean; readonly place: boolean }
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
      readonly context?: readonly AppContext[]
      readonly attachments?: readonly Attachment[]
      readonly author?: string
      /** The thread a note shared into main came from. */
      readonly thread?: string
      /** When it was written (epoch ms), where Pi knows. */
      readonly at?: number
    }
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string; readonly live: boolean }
  | { readonly kind: 'text'; readonly id: string; readonly text: string; readonly live: boolean }
  | ToolPart
  | { readonly kind: 'failure'; readonly id: string; readonly failure: TurnFailure }
  /** A thread the owner started with "+", where main noted it. */
  | { readonly kind: 'thread-started'; readonly id: string; readonly thread: string }

/**
 * A turn the owner took: words typed in this app or sent from Telegram. Messages from an MCP client, a subagent's
 * report, a routine's note and a thread's share-back carry another author and are not turns. In a subagent's or a
 * routine's own conversation the message that starts each run has no author, so it is that conversation's turn.
 */
export function isOwnTurn(part: Part): part is Extract<Part, { readonly kind: 'user' }> {
  return part.kind === 'user' && (part.author === undefined || part.author === TELEGRAM_AUTHOR)
}

/** The MCP server, tool and arguments of an `mcp_call`, when the call has that shape. */
export function mcpTarget(call: ToolCallView): McpTarget | undefined {
  if (call.name !== 'mcp_call') return undefined
  const { serverId, name } = call.arguments
  if (!isString(serverId) || !isString(name)) return undefined
  return { serverId, name, arguments: record(call.arguments.arguments) ?? {} }
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

function assistantParts(message: AssistantMessage, context: Context): Part[] {
  const parts: Part[] = []
  if (message.reasoning !== undefined)
    parts.push({ kind: 'reasoning', id: `${message.id}:reasoning`, text: message.reasoning, live: false })
  if (message.text !== '') parts.push({ kind: 'text', id: `${message.id}:text`, text: message.text, live: false })
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
  if (projection.partialReasoning !== '')
    parts.push({ kind: 'reasoning', id: 'partial:reasoning', text: projection.partialReasoning, live: true })
  if (projection.partial !== '') parts.push({ kind: 'text', id: 'partial:text', text: projection.partial, live: true })
  return parts
}

/** A message in the user column, with who wrote it and when, where those are known. */
function userPart(message: Extract<ChatMessage, { role: 'user' }>): Part {
  return {
    kind: 'user',
    id: message.id,
    text: message.text,
    ...(message.context && { context: message.context }),
    ...(message.attachments && { attachments: message.attachments }),
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
    return undefined
  }
  const built = record(value)
  if (built?.status !== 'active' || !isString(built.app) || typeof built.version !== 'number') return undefined
  return { app: built.app, version: built.version, ui: built.ui === true }
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
    } else if (message.role === 'thread-started')
      parts.push({ kind: 'thread-started', id: message.id, thread: message.thread })
    else if (!seen.has(message.toolCallId))
      // A result whose call is not in the transcript (compacted away) still shows on its own.
      parts.push(
        toolPart({ id: message.toolCallId, name: message.toolName, arguments: {} }, context, message.timestamp),
      )
  }
  return placeApps([...parts, ...liveParts(projection, context, seen)])
}

/** The agent's own tools, in words; any other is "Used" and its name. */
const OWN_TOOLS: Readonly<Record<string, string>> = {
  mcp_list: 'Looked up its tools',
  share_back: 'Shared a note back',
  skill_activate: 'Opened a skill',
  skill_read: 'Read a skill',
}

/** How a tool call reads as one line: "Used" and the server, then the tool; the agent's own tools in words. */
export function toolLine(part: ToolPart): { readonly lead: string; readonly server?: string; readonly tool?: string } {
  if (part.target) return { lead: 'Used', server: part.target.serverId, tool: part.target.name }
  return { lead: OWN_TOOLS[part.call.name] ?? `Used ${part.call.name || 'a tool'}` }
}

/** How long a tool has run (to `now` while it runs) or ran; undefined when its start or end is unknown. */
export function elapsedMs(part: ToolPart, now: number): number | undefined {
  if (part.startedAt === undefined) return undefined
  const end = part.endedAt ?? (part.state === 'running' || part.state === 'pending' ? now : undefined)
  return end === undefined ? undefined : Math.max(0, end - part.startedAt)
}
