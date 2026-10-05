import { table } from './html.ts'
import { semanticSummary } from './semantic.ts'
import { construction, semanticEfficiency } from './construction.ts'
import { factorial } from './factorial.ts'
import { episodes } from './plan.ts'
import type { RunData } from './results.ts'

const number = (value: number | null) =>
  value === null ? 'unknown' : value.toLocaleString('en-US', { maximumFractionDigits: 2 })
function scoreTable(data: RunData) {
  const planned = episodes(data.resolved.manifest, data.resolved.scenarios)
  const efficient = semanticEfficiency(data)
  return table(
    'Independent semantic and strict results',
    [
      'arm',
      'completed / planned',
      'resolved',
      'machine / human',
      'strict passes',
      'semantic passes',
      'evidence passes',
      'abstention checks passed',
      'unsupported',
      'malformed',
      'disagreements / adjudicated',
      'semantic passes / 1M reader tokens',
    ],
    Object.entries(semanticSummary(data)).map(([arm, score]) => [
      arm,
      `${score.completed} / ${planned.filter((episode) => episode.variant.id === arm).length}`,
      String(score.resolved),
      `${score.machineReviewed} / ${score.humanReviewed}`,
      String(score.strictPasses),
      String(score.semanticPasses),
      String(score.evidencePasses),
      String(score.abstentionPasses),
      String(score.unsupported),
      String(score.malformed),
      `${score.disagreements} / ${score.adjudicated}`,
      number(efficient[arm]?.passesPerMillionChargedReaderTokens ?? null),
    ]),
  )
}
function memoryTable(data: RunData) {
  return table(
    'Shared construction charged once per memory',
    [
      'memory',
      'shared arms',
      'API attempts',
      'input / completion',
      'planned / completed answers',
      'input per planned answer',
      'input per completed answer',
      'build API ms',
    ],
    construction(data).memories.map((memory) => [
      memory.memory,
      memory.arms.join(', '),
      String(memory.apiAttempts),
      `${number(memory.chargedInput)} / ${number(memory.chargedOutput)}`,
      `${memory.plannedAnswers} / ${memory.completedAnswers}`,
      number(memory.amortizedPerPlanned.input),
      number(memory.amortizedPerCompleted.input),
      number(memory.apiMs),
    ]),
  )
}
function comparisonTable(data: RunData) {
  return table(
    'Memory and source-search comparisons',
    [
      'effect',
      'baseline → candidate',
      'resolved / planned pairs',
      'semantic gains / losses',
      'strict gains / losses',
      'search-supported gains',
      'decision',
    ],
    factorial(data).comparisons.map((item) => [
      item.effect,
      `${item.baseline} → ${item.candidate}`,
      `${item.resolvedPairs} / ${item.plannedPairs}`,
      `${item.gains} / ${item.losses}`,
      `${item.strictGains} / ${item.strictLosses}`,
      String(item.searchSupportedGains),
      item.promising ? item.conclusion : !item.complete ? 'Incomplete; diagnostic only.' : item.conclusion,
    ]),
  )
}
function stageTable(data: RunData) {
  return table(
    'Durable stage gates and remaining run allowance',
    [
      'cutoff',
      'operational gate',
      'completed / planned',
      'remaining attempts',
      'remaining input',
      'remaining completion',
      'pending answers',
      'reasons',
    ],
    (data.stageReceipts ?? []).map((receipt) => [
      String(receipt.cutoff),
      receipt.passed ? 'passed' : 'failed',
      `${receipt.completedAnswers} / ${receipt.plannedAnswers}`,
      number(receipt.remaining.requests),
      number(receipt.remaining.input),
      number(receipt.remaining.output),
      String(receipt.pendingAnswers.length),
      receipt.reasons.join('; '),
    ]),
  )
}
export function recallTables(data: RunData): string {
  if (data.resolved.manifest.allowance.stages === undefined && (data.semanticVotes?.length ?? 0) === 0) return ''
  return `${scoreTable(data)}${comparisonTable(data)}${memoryTable(data)}${stageTable(data)}<p>Semantic scoring assesses factual meaning and correct abstention without repairing the original answer. Evidence and format are separate checks. Strict passes require all checks. Machine-only votes are diagnostic; human agreement or adjudication resolves a score. Reader efficiency excludes shared construction. This development sample cannot establish model superiority or promote a production policy.</p>`
}
