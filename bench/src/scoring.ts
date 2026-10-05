import type { Answer, Probe, Scenario } from './schema.ts'

export type Truth = { readonly key: string; readonly value: string; readonly evidenceId: string }
export type ProbeScore = {
  readonly correct: boolean
  readonly evidenceComplete: boolean
  readonly evidenceValid: boolean
  readonly abstentionCorrect: boolean
  readonly unsupported: boolean
}

/** Only owner decisions and observed tool results establish prefix truth. */
export function groundTruth(scenario: Scenario, probe: Probe): Truth[] {
  const facts = new Map<string, Truth>()
  for (const event of scenario.events.slice(0, probe.cutoff)) {
    const { fact } = event
    if (fact !== undefined && (fact.authority === 'owner' || fact.authority === 'observation')) {
      facts.set(fact.key, { key: fact.key, value: fact.value, evidenceId: event.id })
    }
  }
  return probe.keys.flatMap((key) => facts.get(key) ?? [])
}

const normalized = (text: string) => text.trim().replaceAll(/\s+/gu, ' ').toLowerCase()

export function scoreProbe(
  scenario: Scenario,
  probe: Probe,
  answer: Answer,
  deliveredIds: readonly string[],
): ProbeScore {
  const truth = groundTruth(scenario, probe)
  const mustAbstain = truth.length !== probe.keys.length
  const evidence = new Set(answer.evidenceIds)
  const allowed = new Set(scenario.events.slice(0, probe.cutoff).map((event) => event.id))
  const delivered = new Set(deliveredIds)
  const unsupported = answer.claims.some(
    (claim) => !truth.some((fact) => fact.key === claim.key && normalized(fact.value) === normalized(claim.value)),
  )
  const evidenceComplete = truth.every((fact) => evidence.has(fact.evidenceId))
  const evidenceValid = answer.evidenceIds.every((id) => allowed.has(id) && delivered.has(id))
  const abstentionCorrect = mustAbstain === answer.abstain
  const claimsCorrect = truth.every((fact) =>
    answer.claims.some((claim) => claim.key === fact.key && normalized(fact.value) === normalized(claim.value)),
  )
  const correct =
    abstentionCorrect &&
    !unsupported &&
    evidenceValid &&
    (mustAbstain ? answer.claims.length === 0 : claimsCorrect && evidenceComplete)
  return { correct, evidenceComplete, evidenceValid, abstentionCorrect, unsupported }
}
