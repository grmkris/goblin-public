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
}
/** What the transcript renders, in order. Every part has a stable id for the scroller. */
export type Part =
  | { readonly kind: 'user'; readonly id: string; readonly text: string }
  | { readonly kind: 'reasoning'; readonly id: string; readonly text: string; readonly live: boolean }
  | { readonly kind: 'text'; readonly id: string; readonly text: string; readonly live: boolean }
  | ToolPart
  | { readonly kind: 'failure'; readonly id: string; readonly failure: TurnFailure }

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
    if (message.role === 'user') parts.push({ kind: 'user', id: message.id, text: message.text })
    else if (message.role === 'assistant') {
      for (const call of message.toolCalls) seen.add(call.id)
      parts.push(...assistantParts(message, context))
    } else if (!seen.has(message.toolCallId))
      // A result whose call is not in the transcript (compacted away) still shows on its own.
      parts.push(
        toolPart({ id: message.toolCallId, name: message.toolName, arguments: {} }, context, message.timestamp),
      )
  }
  return [...parts, ...liveParts(projection, context, seen)]
}

/** How long a tool has run (to `now` while it runs) or ran; undefined when its start or end is unknown. */
export function elapsedMs(part: ToolPart, now: number): number | undefined {
  if (part.startedAt === undefined) return undefined
  const end = part.endedAt ?? (part.state === 'running' || part.state === 'pending' ? now : undefined)
  return end === undefined ? undefined : Math.max(0, end - part.startedAt)
}
