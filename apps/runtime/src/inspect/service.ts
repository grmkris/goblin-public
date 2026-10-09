import type {
  InspectConversations,
  InspectDetails,
  InspectDetailsInput,
  InspectEntries,
  InspectFlows,
  InspectFlowsInput,
  InspectInput,
  InspectKind,
  InspectProblems,
  InspectQuery,
  InspectResult,
  InspectTurns,
  TurnTimeline,
} from '@goblin/contracts/inspect'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'

/** What a query of `kind` takes besides its kind. */
type Input<K extends InspectKind> = (typeof InspectInput)[K]['Type']

/** What any inspection query answers: the result of its kind. */
export type InspectAnswer = { readonly [K in InspectKind]: (typeof InspectResult)[K]['Type'] }[InspectKind]

/**
 * Read-only inspection of this agent (ADR 0024): Pi for content and settlement, the run ledger for how each turn and
 * each conversation flow ran. No read changes the agent or calls a model; a turn, conversation or operation that is not
 * there is `NotFound`, and a details query that names neither an operation nor a chat entry is `InvalidInput`.
 */
export class Inspection extends Context.Service<
  Inspection,
  {
    /** Any query, as the agent's `/inspect` route (and so /mcp's `inspect_*` tools) asks it. */
    readonly run: (query: InspectQuery) => Effect.Effect<InspectAnswer, AppError>
    /** Every conversation the agent keeps (main, threads, subagents, clients), with titles and activity. */
    readonly conversations: Effect.Effect<InspectConversations, AppError>
    /** A page of a conversation's entries, oldest first, ending before `before` (the newest page without it). */
    readonly conversation: (input: Input<'conversation'>) => Effect.Effect<InspectEntries, AppError>
    /** Turns since `since` (the last day by default), newest first, optionally of one conversation. */
    readonly turns: (input: Input<'turns'>) => Effect.Effect<InspectTurns, AppError>
    /** One turn end to end: its summary, Pi's settlement, every run event and what the timeline cannot show. */
    readonly turn: (operationId: string) => Effect.Effect<TurnTimeline, AppError>
    /** Events needing attention since `since`, newest first; `all` includes expected waits and recovered attempts. */
    readonly problems: (input: Input<'problems'>) => Effect.Effect<InspectProblems, AppError>
    /** Conversation flow steps since `since`, newest first, optionally of one chat or one flow. */
    readonly flows: (input: InspectFlowsInput) => Effect.Effect<InspectFlows, AppError>
    /** The details behind a message: the timeline of the operation behind it and the operations related to it. */
    readonly details: (input: InspectDetailsInput) => Effect.Effect<InspectDetails, AppError>
  }
>()('goblin/inspect/Inspection') {}
