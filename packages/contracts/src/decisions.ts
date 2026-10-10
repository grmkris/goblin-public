import * as Schema from 'effect/Schema'
import { EntryId } from './ids.ts'
import { RetrievalSource } from './retrieval.ts'

/** Most sources a context proposal offers (the critic's candidates are the top three of a search). */
export const CONTEXT_SOURCES = 3

/** Owner-only proposals (ADR 0031); confirming one affects an affordance, never the agent's authority or transcripts. */
export const DecisionAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal('highlight'), relayId: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal('thread-draft'), title: Schema.String }),
  /**
   * Excerpts of the owner's other chats judged relevant to the owner's message `inputEntry` (ADR 0031, ADR 0035):
   * confirmed, they are added to the chat's next requests as quoted history.
   */
  Schema.Struct({
    type: Schema.Literal('context'),
    inputEntry: EntryId,
    sources: Schema.NonEmptyArray(RetrievalSource).check(Schema.isMaxLength(CONTEXT_SOURCES)),
  }),
])
export type DecisionAction = typeof DecisionAction.Type

/** The owner's label of a proposal: confirm it or dismiss it. */
export const DecisionLabel = Schema.Struct({ label: Schema.Literals(['confirm', 'dismiss']) })
export type DecisionLabel = typeof DecisionLabel.Type

/**
 * One typed decision the agent proposes to the owner (ADR 0031): what it judged, the action it proposes, how sure it
 * was and who judged it (the rules, or Clef). It stays open until the owner labels it or a newer exchange makes it
 * stale.
 */
export const DecisionProposal = Schema.Struct({
  id: Schema.String,
  chatId: Schema.String,
  kind: Schema.Literals(['attention-triage', 'separate-work', 'context-relevance']),
  subject: Schema.String,
  payload: DecisionAction,
  state: Schema.Literals(['open', 'confirmed', 'dismissed', 'stale']),
  probability: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  provider: Schema.Literals(['rules', 'cloudflare/clef']),
  createdAt: Schema.Number,
  decidedAt: Schema.optional(Schema.Number),
})
export type DecisionProposal = typeof DecisionProposal.Type
