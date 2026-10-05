import { Schema } from 'effect'
import { Delivery, ReplayEvent } from './protocol.ts'
import { Probe } from './schema.ts'
import { resolution, type SemanticVote, type VoteInput } from './semantic.ts'

export const BlindCase = Schema.Struct({
  caseId: Schema.String,
  question: Schema.String,
  category: Probe.fields.category,
  label: Probe.fields.label,
  prefix: Schema.Array(ReplayEvent),
  delivered: Schema.Array(Delivery),
  rawAnswer: Schema.String,
})
export type BlindCase = typeof BlindCase.Type
export const BlindPacket = Schema.Struct({
  packetId: Schema.String,
  instructions: Schema.String,
  cases: Schema.Array(BlindCase),
})
export type BlindPacket = typeof BlindPacket.Type
export const BlindMap = Schema.Struct({
  packetId: Schema.String,
  packetHash: Schema.String,
  runId: Schema.String,
  sourceHash: Schema.String,
  corpusHash: Schema.String,
  cases: Schema.Array(Schema.Struct({ caseId: Schema.String, episodeId: Schema.String, resultHash: Schema.String })),
})
export type BlindMap = typeof BlindMap.Type

export function validateVote(item: BlindCase, vote: VoteInput, previous: readonly SemanticVote[]): string[] {
  const reasons: string[] = []
  if (!vote.voteId.trim() || !vote.reviewer.trim() || !vote.rationale.trim() || !Number.isFinite(Date.parse(vote.at)))
    reasons.push('Vote needs identity, reviewer, rationale and timestamp')
  if (vote.evidenceIds.some((id) => !item.prefix.some((event) => event.id === id)))
    reasons.push('Vote evidence exceeds prefix')
  reasons.push(...evidenceReasons(item, vote))
  if (
    vote.searchSupported &&
    !item.delivered.some(
      (receipt) =>
        (receipt.origin === 'search' || receipt.origin === 'read') &&
        vote.evidenceIds.includes(receipt.id) &&
        item.rawAnswer.includes(receipt.id),
    )
  )
    reasons.push('Search support requires original cited search/read delivery')
  if (previous.some((prior) => prior.kind === vote.kind)) reasons.push('Vote kind already recorded for this case')
  if (
    vote.kind !== 'adjudication' &&
    previous.some((prior) => prior.kind !== vote.kind && prior.reviewer === vote.reviewer)
  )
    reasons.push('Machine and human reviews require independent reviewer identities')
  if (vote.kind !== 'adjudication' && vote.resolves.length > 0) reasons.push('Only adjudication resolves votes')
  if (vote.kind === 'adjudication') reasons.push(...adjudicationReasons(vote, previous))
  return reasons
}
function evidenceReasons(item: BlindCase, vote: VoteInput): string[] {
  const reasons: string[] = []
  if (
    vote.score.evidenceValid &&
    vote.evidenceIds.some(
      (id) => !item.delivered.some((delivery) => delivery.id === id) || !item.rawAnswer.includes(id),
    )
  )
    reasons.push('Valid evidence requires IDs cited in the original answer and delivered to the reader')
  if (
    vote.score.evidenceComplete &&
    item.label?.mustAbstain !== true &&
    (item.label?.requiredClaims.length ?? 0) > 0 &&
    vote.evidenceIds.length === 0
  )
    reasons.push('Complete factual evidence requires cited originals')
  return reasons
}
function adjudicationReasons(vote: VoteInput, previous: readonly SemanticVote[]): string[] {
  const resolved = resolution(previous)
  if (!resolved.disagreed || resolved.machine === undefined || resolved.human === undefined)
    return ['Adjudication requires a machine/human disagreement']
  const expected = [resolved.machine.voteId, resolved.human.voteId].toSorted()
  if (JSON.stringify(vote.resolves.toSorted()) !== JSON.stringify(expected))
    return ['Adjudication must name both disputed vote IDs']
  if (vote.reviewer === resolved.machine.reviewer) return ['Adjudication requires a human reviewer']
  return []
}
