import {
  type Attachment,
  type ComposerOption,
  type McpOutcome,
  type NoticeData,
  type PersonaAnswerData,
  type PersonaTag,
  TELEGRAM_AUTHOR,
  type TopicSeedData,
} from '@goblin/contracts'
import type { SharedContext } from './app-context.ts'
import { isString } from './values.ts'
import type { ChatMessage, ToolCallView, TurnFailure } from './chat-messages.ts'

type ToolResultMessage = Extract<ChatMessage, { role: 'tool' }>

/**
 * Where a tool call is in its life. `pending`: the model asked for it and the run has not started it yet. `running`:
 * executing (or finished, with the result not committed yet). `stopped`: the turn ended before it ran.
 */
export type ToolState = 'pending' | 'running' | 'done' | 'error' | 'stopped'
/** The MCP server, tool and arguments behind an `mcp_call`. */
export type McpTarget = {
  readonly connectionId: string
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
export type ReasoningPart = {
  readonly kind: 'reasoning'
  readonly id: string
  readonly key?: string
  readonly text: string
  readonly live: boolean
}
/**
 * The turn is under way and nothing of it shows: the message was just sent, or a tool finished and the model has not
 * answered yet. It is a model's slow start (seconds, sometimes tens of them), not an error, so the row says so.
 */
export type WorkingPart = { readonly kind: 'working'; readonly id: string }
/** The quiet work of a turn that a `work` part folds: its thinking, its tool calls, and the row that says it is under way. */
export type WorkStep = ReasoningPart | WorkingPart | ToolPart
/** What the transcript renders, in order. Every part has a stable id for the scroller. */
export type Part =
  | {
      readonly kind: 'user'
      readonly id: string
      /** Set on the message just sent, so the row keeps one React key from the echo to the server's entry (`echo.ts`). */
      readonly key?: string
      readonly text: string
      readonly context?: readonly SharedContext[]
      readonly attachments?: readonly Attachment[]
      readonly selections?: readonly ComposerOption[]
      readonly author?: string
      /** How a held call ended, when this is its outcome: one quiet row, not a message (`outcome-row.tsx`). */
      readonly outcome?: McpOutcome
      /** The thread a note shared into main came from. */
      readonly thread?: string
      /** When it was written (epoch ms), where Pi knows. */
      readonly at?: number
    }
  | ReasoningPart
  | { readonly kind: 'text'; readonly id: string; readonly key?: string; readonly text: string; readonly live: boolean }
  | WorkingPart
  /**
   * A run of a turn's quiet work (thinking and tool calls) folded to one line that opens to them (`work-groups.ts`).
   * `live`: something in it is still under way, and the line says what.
   */
  | {
      readonly kind: 'work'
      readonly id: string
      readonly key: string
      readonly steps: readonly WorkStep[]
      readonly live: boolean
    }
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
  /** A routine's notice (ADR 0041): who it is from, what kind it is, its words and its one link. */
  | ({ readonly kind: 'notice'; readonly id: string; readonly at?: number } & Omit<NoticeData, 'notice' | 'routine'>)
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
const DRAWN = new Set<Part['kind']>([
  'thread-head',
  'persona-ask',
  'persona-answer',
  'topic-seed',
  'delegate-result',
  'notice',
  // Nothing varies in it: the row only says the turn is under way.
  'working',
])

/**
 * A turn the owner took: words typed in this app or sent from Telegram. Messages from an MCP client, a subagent's
 * report, a routine's note and a thread's share-back carry another author and are not turns. In a subagent's or a
 * routine's own conversation the message that starts each run has no author, so it is that conversation's turn.
 */
export function isOwnTurn(part: Part): part is Extract<Part, { readonly kind: 'user' | 'persona-ask' }> {
  if (part.kind === 'persona-ask') return true
  return part.kind === 'user' && (part.author === undefined || part.author === TELEGRAM_AUTHOR)
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
  if (a.kind === 'work') return b.kind === 'work' && sameWork(a, b)
  if (a.kind === 'text' || a.kind === 'reasoning') return sameWords(a, b)
  // An entry the app wrote itself never changes: the same id draws the same thing.
  return DRAWN.has(a.kind)
}

const sameWords = (a: ReasoningPart | Extract<Part, { kind: 'text' }>, b: Part) =>
  (b.kind === 'text' || b.kind === 'reasoning') && a.text === b.text && a.live === b.live

type WorkPart = Extract<Part, { kind: 'work' }>
const sameWork = (a: WorkPart, b: WorkPart) =>
  a.live === b.live &&
  a.steps.length === b.steps.length &&
  a.steps.every((step, index) => {
    const other = b.steps[index]
    return other !== undefined && samePart(step, other)
  })

type UserPart = Extract<Part, { kind: 'user' }>
const sameUser = (a: UserPart, b: UserPart) =>
  a.text === b.text &&
  a.context === b.context &&
  a.attachments === b.attachments &&
  a.selections === b.selections &&
  a.author === b.author &&
  a.outcome === b.outcome &&
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

/** The agent's own tools, in words; any other is "Used" and its name. */
const OWN_TOOLS: Readonly<Record<string, string>> = {
  mcp_list: 'Looked up its tools',
  share_back: 'Shared a note back',
  skill_activate: 'Opened a skill',
  skill_read: 'Read a skill',
}

/** How a connection is named to the owner: its label (`useConnectionLabels`), or its id where none is known. */
export type Named = (connectionId: string) => string
const asIs: Named = (connectionId) => connectionId

/**
 * How a tool call reads as one line: "Used" and the connection by its label, then the tool; an `app_call` as the app
 * and its member; the agent's own tools in words.
 */
export function toolLine(
  part: ToolPart,
  named: Named = asIs,
): { readonly lead: string; readonly server?: string; readonly tool?: string } {
  if (part.target) return { lead: 'Used', server: named(part.target.connectionId), tool: part.target.name }
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
