import { Option, Schema } from 'effect'
import { NotInTopic, QuestionSpec, type SetupItem } from '@goblin/contracts'
import { isString, record } from './values.ts'
import type { Part, ToolPart } from './parts.ts'
import { subagentAction } from './threads.ts'

/**
 * Something the agent is waiting on the owner for: answers to `ask_user` questions, permission for an MCP tool it may
 * not call yet, a sign-in with more access (ADR 0042), an MCP server it asks them to add, or something its Topic's
 * setup does not hold that it tried to use (ADR 0040). Each settles with the owner's next message, from this web app or
 * any other channel.
 */
export type Interaction =
  | { readonly kind: 'question'; readonly callId: string; readonly questions: readonly QuestionSpec[] }
  | {
      readonly kind: 'approval'
      readonly callId: string
      readonly approvalId: string
      readonly connectionId: string
      readonly name: string
    }
  | { readonly kind: 'grant'; readonly callId: string; readonly connectionId: string; readonly name: string }
  /** A call needed more access than the connection's sign-in granted: the owner signs in again (ADR 0042). */
  | { readonly kind: 'access'; readonly callId: string; readonly connectionId: string; readonly scope: string }
  | {
      readonly kind: 'server'
      readonly callId: string
      readonly endpoint: string
      readonly name: string
      readonly reason: string
    }
  | {
      readonly kind: 'setup'
      readonly callId: string
      readonly target: SetupItem
      readonly topic: { readonly id: number; readonly name: string }
    }

const decodeQuestions = Schema.decodeUnknownOption(Schema.Array(QuestionSpec))
const decodeNotInTopic = Schema.decodeUnknownOption(NotInTopic)

/** Whether a refused `mcp_call` asked for the server or tool the refusal names. */
function mcpAsked(part: ToolPart, target: SetupItem): boolean {
  const called = part.target
  if (called === undefined || (target.kind !== 'server' && target.kind !== 'tool')) return false
  return called.connectionId === target.connectionId && (target.kind === 'server' || called.name === target.name)
}

/** Whether a refused skill call asked for the library or skill the refusal names, by its handle `<server>:<name>`. */
function skillAsked(handle: unknown, target: SetupItem): boolean {
  if (!isString(handle) || (target.kind !== 'library' && target.kind !== 'skill')) return false
  const [server, skill = ''] = handle.split(':', 2)
  return server === target.connectionId && (target.kind === 'library' || skill.replace(/~\d+$/u, '') === target.name)
}

/**
 * Whether something outside the setup is what the call asked for: the server or tool of an `mcp_call`, the library or
 * skill a skill handle names, or subagents for a subagent tool. Anything else is not trusted.
 */
function asksFor(part: ToolPart, target: SetupItem): boolean {
  const { name, arguments: args } = part.call
  if (name === 'mcp_call') return mcpAsked(part, target)
  if (name === 'skill_activate' || name === 'skill_read') return skillAsked(args.skill, target)
  return subagentAction(part) !== undefined && target.kind === 'subagents'
}

/** An ask to add something to the Topic's setup, only for exactly what the call asked for. */
function setupOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  return Option.match(decodeNotInTopic(details), {
    onNone: () => undefined,
    onSome: ({ target, topic }) =>
      asksFor(part, target) ? { kind: 'setup', callId: part.call.id, target, topic } : undefined,
  })
}

/** goblin's own error results that ask the owner, by their details' `kind`. */
const MARKERS = new Map<string, (part: ToolPart, details: Record<string, unknown>) => Interaction | undefined>([
  ['approval-required', approvalOf],
  ['grant-required', grantOf],
  ['scope-required', accessOf],
  ['not-in-topic', setupOf],
])

/**
 * The interaction a tool result asks for, if any. A grant request is trusted only from goblin's own `mcp_call`
 * result: an error whose details carry `kind: 'grant-required'` for exactly the server and tool that were called, and
 * no `origin` (remote results always have one), so a server's content cannot conjure an Allow card. A request for more
 * access (`scope-required`) is trusted the same way, for the connection that was called. An ask to add
 * something to the Topic's setup (`not-in-topic`) is trusted the same way, for exactly what the call asked for.
 */
export function interactionOf(part: ToolPart): Interaction | undefined {
  const result = part.result
  const details = record(result?.details)
  if (result === undefined || details === undefined || 'origin' in details) return undefined
  if (result.isError) return isString(details.kind) ? MARKERS.get(details.kind)?.(part, details) : undefined
  if (part.call.name === 'mcp_request_server' && !result.isError && details.kind === 'server-request')
    return serverOf(part, details)
  if (part.call.name === 'ask_user' && !result.isError && details.kind === 'question')
    return Option.match(decodeQuestions(details.questions), {
      onNone: () => undefined,
      onSome: (questions) => ({ kind: 'question', callId: part.call.id, questions }),
    })
  return undefined
}

/** Local approval markers must match the exact MCP target; the record is then fetched from the owner API. */
function approvalOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined || !isString(details.approvalId)) return undefined
  if (details.connectionId !== target.connectionId || details.name !== target.name) return undefined
  return {
    kind: 'approval',
    callId: part.call.id,
    approvalId: details.approvalId,
    connectionId: target.connectionId,
    name: target.name,
  }
}

/** A grant request, only from `mcp_call` and only for exactly the server and tool that were called. */
function grantOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined) return undefined
  if (details.connectionId !== target.connectionId || details.name !== target.name) return undefined
  return { kind: 'grant', callId: part.call.id, connectionId: target.connectionId, name: target.name }
}

/** A request for more access, only from `mcp_call` and only for the connection that was called. */
function accessOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined || details.connectionId !== target.connectionId)
    return undefined
  const scope = isString(details.scope) ? details.scope.slice(0, 512) : ''
  return { kind: 'access', callId: part.call.id, connectionId: target.connectionId, scope }
}

/** A request to add a server, only from `mcp_request_server` and only for an https endpoint without credentials. */
function serverOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const { endpoint, name, reason } = details
  if (!isString(endpoint) || !isString(name) || !isString(reason)) return undefined
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  } catch {
    // expected: an endpoint that is not a URL is no server request, and the call shows as an ordinary tool call
    return undefined
  }
  return { kind: 'server', callId: part.call.id, endpoint, name: name.slice(0, 80), reason: reason.slice(0, 300) }
}

/** One ask to add an item to a Topic per item: the agent may be refused the same thing twice in a turn. */
const setupKey = (interaction: Interaction): string | undefined =>
  interaction.kind === 'setup' ? `${String(interaction.topic.id)}:${JSON.stringify(interaction.target)}` : undefined

/**
 * The interactions still waiting: those after the owner's last message. Any later message settles them. Asks to add
 * the same item to the Topic show once, as the latest.
 */
export function openInteractions(parts: readonly Part[]): Interaction[] {
  const lastUser = parts.findLastIndex((part) => part.kind === 'user')
  const open = parts.flatMap((part, index) => {
    if (part.kind !== 'tool') return []
    const interaction = interactionOf(part)
    return interaction === undefined || (interaction.kind !== 'approval' && index <= lastUser) ? [] : [interaction]
  })
  return open.filter((interaction, index) => {
    const key = setupKey(interaction)
    return key === undefined || !open.slice(index + 1).some((later) => setupKey(later) === key)
  })
}

const OPERATION = {
  approval: 'approval',
  question: 'answer',
  grant: 'grant',
  access: 'access',
  setup: 'setup',
  server: 'server',
} as const

/** Stable submission ids: a double click, a retry or a second tab submits the same answer once. */
export const interactionOperation = (interaction: Interaction): string =>
  `${OPERATION[interaction.kind]}:${interaction.callId}`

/**
 * The owner's answers as their next message: one line per question, choices by their labels, a free answer after
 * them, `(skipped)` where nothing was given. `values(id)` is what the form holds under that question's name.
 */
export function answerText(questions: readonly QuestionSpec[], values: (id: string) => readonly unknown[]): string {
  const lines = questions.map((question) => {
    const labels = new Map((question.options ?? []).map((option) => [option.id, option.label]))
    const given = values(question.id)
      .filter(isString)
      .map((value) => value.trim())
      .filter((value) => value !== '')
      .map((value) => labels.get(value) ?? value)
    return `- ${question.prompt} ${given.length === 0 ? '(skipped)' : given.join(', ')}`
  })
  return ['Answers:', ...lines].join('\n')
}
