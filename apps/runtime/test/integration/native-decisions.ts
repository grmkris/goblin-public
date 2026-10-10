import { DecisionProposal } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { expect } from 'vitest'
import { Ok, Refused } from './conversation-checks.ts'
import { type NativeCase, probeCase } from './native-case.ts'

const Proof = Schema.Struct({
  once: Schema.Boolean,
  confirmed: Ok(DecisionProposal),
  replay: Ok(DecisionProposal),
  opposite: Refused,
  dismissed: Ok(DecisionProposal),
  staleDiscarded: Schema.Boolean,
  noBudgetCall: Schema.Boolean,
  unboundIdle: Schema.Boolean,
  charged: Schema.Number,
  ownerCandidate: Schema.Boolean,
  evidenceFence: Schema.Boolean,
  labels: Schema.Array(Schema.Struct({ proposalId: Schema.String, label: Schema.String, probability: Schema.Number })),
  retained: Schema.Array(DecisionProposal),
  chatAnswer: Schema.String,
})

/** Typed decisions in a live object's SQLite and Pi (ADR 0031), labelled through the owner API (`decisions` probe). */
export const cases: readonly NativeCase[] = [
  probeCase(
    'decisions are judged once, the first label wins, and failures leave chat working',
    'decisions',
    Proof,
    (result) => {
      expect(result.once).toBe(true)
      expect(result.confirmed.value.state).toBe('confirmed')
      expect(result.replay.value).toEqual(result.confirmed.value)
      expect(result.opposite.error._tag).toBe('Conflict')
      expect(result.dismissed.value.state).toBe('dismissed')
      expect(result.labels.map((label) => label.label).toSorted()).toEqual(['confirm', 'dismiss'])
      expect(result.labels.every((label) => label.probability === 0.85)).toBe(true)
      expect(result.retained.map((proposal) => proposal.id)).toEqual([result.confirmed.value.id])
      expect(result.staleDiscarded).toBe(true)
      expect(result.noBudgetCall).toBe(true)
      expect(result.unboundIdle).toBe(true)
      expect(result.charged).toBe(3000)
      expect(result.ownerCandidate).toBe(true)
      expect(result.evidenceFence).toBe(true)
      expect(result.chatAnswer.length).toBeGreaterThan(0)
    },
  ),
]
