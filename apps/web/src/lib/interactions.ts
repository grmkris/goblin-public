import { Option, Schema } from 'effect'
import { QuestionSpec } from '@goblin/contracts'
import { isString, record } from './values.ts'
import type { Part, ToolPart } from './parts.ts'

/**
 * Something the agent is waiting on the owner for: answers to `ask_user` questions, permission for an MCP tool it may
 * not call yet, or an MCP server it asks them to add. Each settles with the owner's next message, from this web app or any other channel.
 */
export type Interaction =
  | { readonly kind: 'question'; readonly callId: string; readonly questions: readonly QuestionSpec[] }
  | {
      readonly kind: 'approval'
      readonly callId: string
      readonly approvalId: string
      readonly serverId: string
      readonly name: string
    }
  | { readonly kind: 'grant'; readonly callId: string; readonly serverId: string; readonly name: string }
  | {
      readonly kind: 'server'
      readonly callId: string
      readonly endpoint: string
      readonly name: string
      readonly reason: string
    }

const decodeQuestions = Schema.decodeUnknownOption(Schema.Array(QuestionSpec))

/**
 * The interaction a tool result asks for, if any. A grant request is trusted only from goblin's own `mcp_call`
 * result: an error whose details carry `kind: 'grant-required'` for exactly the server and tool that were called, and
 * no `origin` (remote results always have one), so a server's content cannot conjure an Allow card.
 */
export function interactionOf(part: ToolPart): Interaction | undefined {
  const result = part.result
  const details = record(result?.details)
  if (result === undefined || details === undefined || 'origin' in details) return undefined
  if (result.isError && details.kind === 'approval-required') return approvalOf(part, details)
  if (result.isError && details.kind === 'grant-required') return grantOf(part, details)
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
  if (details.serverId !== target.serverId || details.name !== target.name) return undefined
  return {
    kind: 'approval',
    callId: part.call.id,
    approvalId: details.approvalId,
    serverId: target.serverId,
    name: target.name,
  }
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
    // expected: an endpoint that is not a URL is no server request, and the call shows as an ordinary tool call
    return undefined
  }
  return { kind: 'server', callId: part.call.id, endpoint, name: name.slice(0, 80), reason: reason.slice(0, 300) }
}

/** The interactions still waiting: those after the owner's last message. Any later message settles them. */
export function openInteractions(parts: readonly Part[]): Interaction[] {
  const lastUser = parts.findLastIndex((part) => part.kind === 'user')
  return parts.flatMap((part, index) => {
    if (part.kind !== 'tool') return []
    const interaction = interactionOf(part)
    return interaction === undefined || (interaction.kind !== 'approval' && index <= lastUser) ? [] : [interaction]
  })
}

const OPERATION = {
  approval: 'approval',
  question: 'answer',
  grant: 'grant',
  capability: 'capability',
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
