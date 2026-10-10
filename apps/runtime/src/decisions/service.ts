import type { DecisionLabel, DecisionProposal } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Option from 'effect/Option'
import type { AppError } from '../http/errors.ts'
import type { DelegateReport } from './candidates.ts'

declare module '../runtime/changes.ts' {
  interface ChangeTopics {
    /** Decision proposals made, labelled or made stale, by id (ADR 0031). */
    'decisions.changed': { readonly ids: readonly string[] }
  }
}

/**
 * Typed decisions (ADR 0031): owner-confirmed proposals the agent makes about its own chats, judged by state-only
 * rules first and Clef for what they leave undecided. A proposal never grants authority, moves history, hides a
 * question or reroutes a send; the owner's label is kept, and the first one wins. Without Clef nothing is judged.
 */
export class Decisions extends Context.Service<
  Decisions,
  {
    /**
     * Judges the owner's answered exchange in chat `session`: whether it could be a thread, and which earlier work in
     * the owner's other chats could help with it. Optional side work: it never fails, and a failure proposes nothing.
     */
    readonly afterYield: (session: string) => Effect.Effect<void>
    /**
     * Judges a Delegate's final report: whether it deserves the owner's attention. Keyed by its relay, so a report is
     * judged once. Optional side work, as `afterYield` is.
     */
    readonly afterReport: (report: DelegateReport) => Effect.Effect<void>
    /**
     * The owner's label of proposal `id`, answered with the proposal as it is now. The first label wins: the same one
     * again answers the same, the other is `Conflict` (`settled`), and confirming one whose chat moved on since it was
     * judged makes it stale and is `Conflict` (`stale`). `NotFound` when there is no proposal `id`.
     */
    readonly label: (id: string, label: DecisionLabel['label']) => Effect.Effect<DecisionProposal, AppError>
    /**
     * The earlier work the owner chose to use in the chat of `session` (its newest context proposal confirmed in the
     * last day), as goblin's note for a request. Each later owner message it serves records that use once, mode
     * `auto`, so the answer's source strip names what it was given.
     */
    readonly chosenContext: (session: string) => Effect.Effect<Option.Option<string>, AppError>
    /** The newest open and confirmed proposals (at most 100), oldest first: the workspace feed's snapshot. */
    readonly list: Effect.Effect<readonly DecisionProposal[], AppError>
    /** Proposal `id` as it is now; `NotFound` when there is none. */
    readonly view: (id: string) => Effect.Effect<DecisionProposal, AppError>
  }
>()('goblin/decisions/Decisions') {}
