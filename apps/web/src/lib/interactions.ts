import { Option, Schema } from 'effect'
import { CapabilityTarget, QuestionSpec } from '@goblin/contracts'
import { isString, record } from './boundary.ts'
import type { Part, ToolPart } from './parts.ts'
import { subagentAction } from './threads.ts'

/**
 * Something the agent is waiting on the owner for: answers to `ask_user` questions, permission for an MCP tool it may
 * not call yet, something switched off in this conversation that it tried to use, or an MCP server it asks them to
 * add. Each settles with the owner's next message, from this web app or any other channel.
 */
export type Interaction =
  | { readonly kind: 'question'; readonly callId: string; readonly questions: readonly QuestionSpec[] }
  | { readonly kind: 'grant'; readonly callId: string; readonly serverId: string; readonly name: string }
  | { readonly kind: 'capability'; readonly callId: string; readonly target: CapabilityTarget }
  | {
      readonly kind: 'server'
      readonly callId: string
      readonly endpoint: string
      readonly name: string
      readonly reason: string
    }

const decodeQuestions = Schema.decodeUnknownOption(Schema.Array(QuestionSpec))
const decodeTarget = Schema.decodeUnknownOption(CapabilityTarget)

/**
 * Whether a switched-off target is what the call asked for: the server or tool of an `mcp_call`, the library a skill
 * handle (`<server>:<name>`) comes from, or subagents for a subagent tool. Anything else is not trusted.
 */
function asksFor(part: ToolPart, target: CapabilityTarget): boolean {
  const { name, arguments: args } = part.call
  if (name === 'mcp_call') {
    const called = part.target
    if (called === undefined || target.kind === 'skills' || target.kind === 'subagents') return false
    return called.serverId === target.serverId && (target.kind === 'server' || called.name === target.name)
  }
  if (name === 'skill_activate' || name === 'skill_read')
    return target.kind === 'skills' && isString(args.skill) && args.skill.split(':', 1)[0] === target.serverId
  return subagentAction(part) !== undefined && target.kind === 'subagents'
}

/**
 * The interaction a tool result asks for, if any. A grant request is trusted only from goblin's own `mcp_call`
 * result: an error whose details carry `kind: 'grant-required'` for exactly the server and tool that were called, and
 * no `origin` (remote results always have one), so a server's content cannot conjure an Allow card. A request to turn
 * something on here (`capability-off`) is trusted the same way, for exactly what the call asked for.
 */
export function interactionOf(part: ToolPart): Interaction | undefined {
  const result = part.result
  const details = record(result?.details)
  if (result === undefined || details === undefined || 'origin' in details) return undefined
  if (result.isError && details.kind === 'grant-required') return grantOf(part, details)
  if (result.isError && details.kind === 'capability-off') {
    const target = Option.getOrUndefined(decodeTarget(details.target))
    return target !== undefined && asksFor(part, target)
      ? { kind: 'capability', callId: part.call.id, target }
      : undefined
  }
  if (part.call.name === 'mcp_request_server' && !result.isError && details.kind === 'server-request')
    return serverOf(part, details)
  if (part.call.name === 'ask_user' && !result.isError && details.kind === 'question')
    return Option.match(decodeQuestions(details.questions), {
      onNone: () => undefined,
      onSome: (questions) => ({ kind: 'question', callId: part.call.id, questions }),
    })
  return undefined
}

/** A grant request, only from `mcp_call` and only for exactly the server and tool that were called. */
function grantOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined) return undefined
  if (details.serverId !== target.serverId || details.name !== target.name) return undefined
  return { kind: 'grant', callId: part.call.id, serverId: target.serverId, name: target.name }
}

/** A request to add a server, only from `mcp_request_server` and only for an https endpoint without credentials. */
function serverOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const { endpoint, name, reason } = details
  if (!isString(endpoint) || !isString(name) || !isString(reason)) return undefined
  try {
    const url = new URL(endpoint)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return undefined
  } catch {
    return undefined
  }
  return { kind: 'server', callId: part.call.id, endpoint, name: name.slice(0, 80), reason: reason.slice(0, 300) }
}

/** The interactions still waiting: those after the owner's last message. Any later message settles them. */
export function openInteractions(parts: readonly Part[]): Interaction[] {
  const lastUser = parts.findLastIndex((part) => part.kind === 'user')
  return parts.slice(lastUser + 1).flatMap((part) => {
    if (part.kind !== 'tool') return []
    const interaction = interactionOf(part)
    return interaction === undefined ? [] : [interaction]
  })
}

const OPERATION = { question: 'answer', grant: 'grant', capability: 'capability', server: 'server' } as const

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
