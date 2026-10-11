// A conversation's transcript as render parts (`parts.ts`): the projection's messages in order, each tool result folded
// into the call that asked for it, the turn in flight after them, and each App build marked where its view shows.
import type { ChatMessage, ToolCallView } from './chat-messages.ts'
import { type Echo, delivered } from './echo.ts'
import { type AppBuilt, type McpTarget, type Part, type ToolPart, type ToolState, partKey } from './parts.ts'
import type { ConversationProjection, LiveTool, ToolTimes } from './projection.ts'
import { isString, record } from './values.ts'

type AssistantMessage = Extract<ChatMessage, { role: 'assistant' }>
type ToolResultMessage = Extract<ChatMessage, { role: 'tool' }>

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
function mcpTarget(call: ToolCallView): McpTarget | undefined {
  if (call.name !== 'mcp_call') return undefined
  const { connectionId, name } = call.arguments
  if (!isString(connectionId) || !isString(name)) return undefined
  return { connectionId, name, arguments: objectArgument(call.arguments.arguments) ?? {} }
}

function toolState(result: ToolResultMessage | undefined, live: LiveTool | undefined, running: boolean): ToolState {
  if (result !== undefined) return result.isError ? 'error' : 'done'
  if (live !== undefined) return 'running'
  return running ? 'pending' : 'stopped'
}

type Context = {
  readonly results: ReadonlyMap<string, ToolResultMessage>
  readonly live: ReadonlyMap<string, LiveTool>
  readonly times: ReadonlyMap<string, ToolTimes>
  readonly running: boolean
}

function toolPart(call: ToolCallView, context: Context, askedAt: number | undefined): ToolPart {
  const result = context.results.get(call.id)
  const live = context.live.get(call.id)
  const target = mcpTarget(call)
  // What this browser saw when it saw it, for the whole life of the row; else the live start, else the asking message's.
  const times = context.times.get(call.id)
  const startedAt = times?.startedAt ?? live?.startedAt ?? askedAt
  const endedAt = times?.endedAt ?? result?.timestamp
  return {
    kind: 'tool',
    id: `tool:${call.id}`,
    call,
    ...(target === undefined ? {} : { target }),
    ...(result === undefined ? {} : { result }),
    state: toolState(result, live, context.running),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
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

/**
 * The in-flight turn: the streaming thinking and text, then the tools whose asking message is not committed yet. That is
 * the order a committed message has (`assistantParts`), so a row does not change places when the message commits.
 */
function liveParts(projection: ConversationProjection, context: Context, seen: ReadonlySet<string>): Part[] {
  const parts: Part[] = []
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
  const tools = projection.tools
    .filter((tool) => !seen.has(tool.callId))
    .map((tool) => toolPart({ id: tool.callId, name: tool.name, arguments: tool.args }, context, tool.startedAt))
  return [...parts, ...tools]
}

/**
 * The row that says the turn is under way while nothing of it shows: after the owner's message (or its echo) and after
 * a tool's result, until the model's thinking, answer or next tool arrives. Not after an answer, which a turn that is
 * about to end also leaves last.
 */
function workingParts(projection: ConversationProjection, parts: readonly Part[], sending: boolean): Part[] {
  if (!projection.running && !sending) return []
  const last = parts.at(-1)
  const waiting =
    last === undefined ||
    last.kind === 'user' ||
    last.kind === 'persona-ask' ||
    (last.kind === 'tool' && (last.state === 'done' || last.state === 'error'))
  return waiting ? [{ kind: 'working', id: 'working' }] : []
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
function builtApp(call: ToolCallView, result: ToolResultMessage | undefined): Omit<AppBuilt, 'place'> | undefined {
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

function contextOf(projection: ConversationProjection): Context {
  const results = new Map<string, ToolResultMessage>()
  for (const message of projection.messages) if (message.role === 'tool') results.set(message.toolCallId, message)
  return {
    results,
    live: new Map(projection.tools.map((tool) => [tool.callId, tool])),
    times: projection.toolTimes ?? new Map(),
    running: projection.running,
  }
}

/**
 * The parts of one message. `seen` gathers the calls the assistant asked for; `key` is the echo's, when this is the
 * owner's message that the echo stood for.
 */
function messageParts(message: ChatMessage, context: Context, seen: Set<string>, key: string | undefined): Part[] {
  if (message.role === 'user') {
    const part = userPart(message)
    return [key !== undefined && part.kind === 'user' ? { ...part, key } : part]
  }
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) seen.add(call.id)
    return assistantParts(message, context)
  }
  // A result whose call is not in the transcript (compacted away) still shows on its own.
  if (message.role === 'tool')
    return seen.has(message.toolCallId)
      ? []
      : [toolPart({ id: message.toolCallId, name: message.toolName, arguments: {} }, context, message.timestamp)]
  return [drawnPart(message)]
}

/**
 * The transcript as render parts: each tool result folds into the call that asked for it. `echo` is a message just
 * sent that the stream has not delivered yet; it shows until it has, and the server's entry then takes its key.
 */
export function conversationParts(projection: ConversationProjection, echo?: Echo): Part[] {
  const context = contextOf(projection)
  const seen = new Set<string>()
  const landed = echo === undefined ? undefined : delivered(echo, projection.messages)
  const parts = projection.messages.flatMap((message) =>
    messageParts(message, context, seen, message === landed ? echo?.id : undefined),
  )
  const sending = echo !== undefined && landed === undefined
  if (sending) parts.push({ kind: 'user', id: echo.id, key: echo.id, text: echo.text })
  const shown = [...parts, ...liveParts(projection, context, seen)]
  return uniqueKeys(placeApps([...shown, ...workingParts(projection, shown, sending)]))
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
