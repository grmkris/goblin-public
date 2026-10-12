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
  /** A call to a connection the owner has not signed in to: they connect it (ADR 0043). */
  | { readonly kind: 'connect'; readonly callId: string; readonly connectionId: string; readonly name: string }
  /** A call needed more access than the connection's sign-in granted: the owner signs in again (ADR 0042). */
  | {
      readonly kind: 'access'
      readonly callId: string
      readonly connectionId: string
      readonly scope: string
      /** The tool that needed it, when the result names it. */
      readonly name?: string
    }
  /** A server asks the owner to finish a step on its site first: its URL request, read from the owner API (ADR 0042). */
  | {
      readonly kind: 'url'
      readonly callId: string
      readonly requestId: string
      readonly connectionId: string
      readonly name: string
    }
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
  ['connect-required', connectOf],
  ['scope-required', accessOf],
  ['url-required', urlOf],
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

/** A sign-in the owner owes, only from `mcp_call` and only for the connection and tool that were called. */
function connectOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined) return undefined
  if (details.connectionId !== target.connectionId || details.name !== target.name) return undefined
  return { kind: 'connect', callId: part.call.id, connectionId: target.connectionId, name: target.name }
}

/** A request for more access, only from `mcp_call` and only for the connection that was called. */
function accessOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined || details.connectionId !== target.connectionId)
    return undefined
  const scope = isString(details.scope) ? details.scope.slice(0, 512) : ''
  return { kind: 'access', callId: part.call.id, connectionId: target.connectionId, scope, name: target.name }
}

/** A URL request, only from `mcp_call` and only for exactly the server and tool that were called. */
function urlOf(part: ToolPart, details: Record<string, unknown>): Interaction | undefined {
  const target = part.target
  if (part.call.name !== 'mcp_call' || target === undefined || !isString(details.requestId)) return undefined
  if (details.connectionId !== target.connectionId || details.name !== target.name) return undefined
  return {
    kind: 'url',
    callId: part.call.id,
    requestId: details.requestId,
    connectionId: target.connectionId,
    name: target.name,
  }
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

/** What waits in goblin's own store, not in the chat: a later message does not settle it. */
const STORED: ReadonlySet<Interaction['kind']> = new Set(['approval', 'url'])

/**
 * The interactions still waiting: those after the owner's last message, which settles every other one, and held calls
 * and URL requests until their store says they are done. Asks to add the same item to the Topic show once, as the
 * latest.
 */
export function openInteractions(parts: readonly Part[]): Interaction[] {
  const lastUser = parts.findLastIndex((part) => part.kind === 'user')
  const open = parts.flatMap((part, index) => {
    if (part.kind !== 'tool') return []
    const interaction = interactionOf(part)
    return interaction === undefined || (!STORED.has(interaction.kind) && index <= lastUser) ? [] : [interaction]
  })
  return open.filter((interaction, index) => {
    const key = setupKey(interaction)
    return key === undefined || !open.slice(index + 1).some((later) => setupKey(later) === key)
  })
}

/**
 * Where a stored ask stands (a held call's or a URL request's state), by its approval or request id: `gone` when its
 * store no longer has it (pruned), absent while it has not been read.
 */
export type StoredStates = ReadonlyMap<string, string>

/** The stored ask's id in its store. */
export const storedId = (interaction: Interaction): string | undefined =>
  interaction.kind === 'approval'
    ? interaction.approvalId
    : interaction.kind === 'url'
      ? interaction.requestId
      : undefined

/**
 * The interactions with each held call whose approved dispatch met a URL request (ADR 0042) followed to that request,
 * by the approvals' ids in `asked` (approval id to request id): the call goes on as the request, so its card and its
 * state are the request's. The same list when nothing was asked.
 */
export function followUrlRequests(
  open: readonly Interaction[],
  asked: ReadonlyMap<string, string>,
): readonly Interaction[] {
  if (asked.size === 0) return open
  return open.map((interaction) => {
    if (interaction.kind !== 'approval') return interaction
    const requestId = asked.get(interaction.approvalId)
    if (requestId === undefined) return interaction
    const { callId, connectionId, name } = interaction
    return { kind: 'url', callId, requestId, connectionId, name }
  })
}

/** The states a stored ask is still under way in: waiting on the owner, or on its way after their answer. */
const UNDER_WAY: Readonly<Record<'approval' | 'url', ReadonlySet<string>>> = {
  approval: new Set(['pending', 'approved', 'dispatching']),
  url: new Set(['pending', 'retrying']),
}

/**
 * The open interactions the dock still shows: every one that is not stored, and a stored one while its store says it is
 * under way or has not been read yet. One that ended, or that its store forgot, leaves; its outcome row says how it went.
 */
export function stillOpen(open: readonly Interaction[], states: StoredStates): Interaction[] {
  return open.filter((interaction) => {
    const id = storedId(interaction)
    if (id === undefined || (interaction.kind !== 'approval' && interaction.kind !== 'url')) return true
    const state = states.get(id)
    return state === undefined || UNDER_WAY[interaction.kind].has(state)
  })
}

/**
 * How many of the dock's interactions wait on the owner right now: every one that is not stored, and a stored one only
 * while it is pending. One under way after their answer, or not read yet, does not.
 */
export const waitingOnOwner = (open: readonly Interaction[], states: StoredStates): number =>
  open.filter((interaction) => {
    const id = storedId(interaction)
    return id === undefined || states.get(id) === 'pending'
  }).length

const OPERATION = {
  approval: 'approval',
  question: 'answer',
  grant: 'grant',
  connect: 'connect',
  access: 'access',
  url: 'url',
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
