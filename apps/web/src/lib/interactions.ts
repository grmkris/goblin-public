import { Option, Schema } from 'effect'
import { QuestionSpec } from '@purrable/contracts'
import { isString, record } from './boundary.ts'
import type { Part, ToolPart } from './parts.ts'

/**
 * Something the agent is waiting on the owner for: answers to `ask_user` questions, or permission for an MCP tool it
 * may not call yet. Both settle with the owner's next message, from this web app or any other channel.
 */
export type Interaction =
  | { readonly kind: 'question'; readonly callId: string; readonly questions: readonly QuestionSpec[] }
  | { readonly kind: 'grant'; readonly callId: string; readonly serverId: string; readonly name: string }

const decodeQuestions = Schema.decodeUnknownOption(Schema.Array(QuestionSpec))

/**
 * The interaction a tool result asks for, if any. A grant request is trusted only from Purrable's own `mcp_call`
 * result: an error whose details carry `kind: 'grant-required'` for exactly the server and tool that were called, and
 * no `origin` (remote results always have one), so a server's content cannot conjure an Allow card.
 */
export function interactionOf(part: ToolPart): Interaction | undefined {
  const result = part.result
  const details = record(result?.details)
  if (result === undefined || details === undefined || 'origin' in details) return undefined
  if (part.call.name === 'mcp_call' && result.isError && details.kind === 'grant-required') {
    const target = part.target
    if (target === undefined || details.serverId !== target.serverId || details.name !== target.name) return undefined
    return { kind: 'grant', callId: part.call.id, serverId: target.serverId, name: target.name }
  }
  if (part.call.name === 'ask_user' && !result.isError && details.kind === 'question')
    return Option.match(decodeQuestions(details.questions), {
      onNone: () => undefined,
      onSome: (questions) => ({ kind: 'question', callId: part.call.id, questions }),
    })
  return undefined
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

/** Stable submission ids: a double click, a retry or a second tab submits the same answer once. */
export const interactionOperation = (interaction: Interaction): string =>
  `${interaction.kind === 'question' ? 'answer' : 'grant'}:${interaction.callId}`

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
