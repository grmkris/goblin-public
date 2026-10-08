import { arms, tasks, type Fixture, type Row, type Attempt } from './schema.ts'
import type { Manifest } from './manifest.ts'
import { summarize } from './scoring.ts'
import { totals } from './budget.ts'

const pct = (value: number | null): string => (value === null ? 'n/a' : (100 * value).toFixed(1) + '%')
const usd = (value: number | null): string => (value === null ? 'unknown' : '$' + value.toFixed(6))
export function reportData(
  manifest: Manifest,
  fixtures: readonly Fixture[],
  rows: readonly Row[],
  attempts: readonly Attempt[],
) {
  const metrics = tasks.flatMap((task) =>
    arms.map((arm) => ({
      task,
      arm,
      ...summarize(
        fixtures,
        rows.filter((row) => row.task === task && row.arm === arm),
      ),
    })),
  )
  return {
    runId: manifest.runId,
    fixtureHash: manifest.fixtureHash,
    sourceHash: manifest.sourceHash,
    totals: totals(attempts),
    metrics,
  }
}
type Report = ReturnType<typeof reportData>
function qualityTables(data: Report): string[] {
  const lines = [
    '# Goblin decision-model evaluation',
    '',
    'Run ' + data.runId + '; fixture SHA-256 ' + data.fixtureHash + '; source SHA-256 ' + data.sourceHash + '.',
    '',
    '160 synthetic labelled cases, 40 per task. Three live repetitions share the frozen fixture set. Each task covers ordinary, ambiguous, contradictory, missing, stale and do-nothing evidence. Relevance has 3–8 permitted candidates and none-relevant. Brief updates score type, duplicate and conflict together. Attention contains ordinary results only. Organization uses only offered existing IDs.',
    '',
    '| Task | Arm | Correct / judged | Accuracy | Question accuracy | Errors / timeouts / format / skipped | Rules | p50 / p95 ms | Charged USD | Priced USD |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const item of data.metrics)
    lines.push(
      '| ' +
        [
          item.task,
          item.arm,
          item.correct + '/' + item.judged,
          pct(item.accuracy),
          pct(item.questionAccuracy),
          [item.providerErrors, item.timeouts, item.invalidAnswers, item.skipped].join('/'),
          item.ruleDecisions,
          String(item.p50Ms) + '/' + String(item.p95Ms),
          usd(item.chargedUsd),
          usd(item.actualCostUsd),
        ].join(' | ') +
        ' |',
    )
  return lines
}
function calibrationTables(data: Report): string[] {
  const lines: string[] = []
  lines.push(
    '',
    '| Task | Arm | Wrong context | Wrong decision type | Missed highlights | Extra highlights | Extra organization | Threshold | Precision | Recall |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  )
  for (const item of data.metrics)
    lines.push(
      '| ' +
        [
          item.task,
          item.arm,
          item.wrongContext,
          item.wrongDecision,
          item.missedHighlight,
          item.unnecessaryHighlight,
          item.unnecessarySuggestion,
          item.threshold?.value.toFixed(4) ?? 'n/a',
          pct(item.threshold?.precision ?? null),
          pct(item.threshold?.recall ?? null),
        ].join(' | ') +
        ' |',
    )
  lines.push(
    '',
    'Accuracy requires every question for a case to match. Provider/timeout/format failures are separate from judgment errors. Prices use published input rates for Clef ($0.24/M), Clef-flash ($0.09/M), Jev ($0.042/M) and Decisions ($0.10/M). Cheap chat charges use a conservative $1/M input + $5/M completion rate because the CLIProxy invoice rate is unavailable; priced cost stays unknown. Unknown usage retains the complete reservation. Batch latency is shared by its two cases; rule-only latency is zero. Failed and denied calls remain charged where inference usage is unknown.',
    '',
    '| Task | Arm | Probability bucket | N | Mean confidence | Correctness |',
    '| --- | --- | --- | ---: | ---: | ---: |',
  )
  for (const item of data.metrics)
    for (const bucket of item.calibration)
      lines.push(
        '| ' +
          [
            item.task,
            item.arm,
            bucket.lower.toFixed(1) + '–' + bucket.upper.toFixed(1),
            bucket.count,
            pct(bucket.meanConfidence),
            pct(bucket.correctness),
          ].join(' | ') +
          ' |',
      )
  return lines
}
function repetitionTable(data: Report): string[] {
  const lines = [
    '',
    'Calibration uses the probability of the chosen answer against correctness. Rules have deterministic 0/1 outputs; these are policy scores, not learned confidence. Positive classes are candidate inclusion, any durable brief type, highlight, and an organization action (suggest/reuse). Each threshold maximizes positive precision subject to >=70% recall; ties favor recall, then the higher threshold. Thresholds were fit on this same development set and require independent owner-label validation before automatic behavior.',
    '',
    '| Task | Arm | Repetition 1 | Repetition 2 | Repetition 3 |',
    '| --- | --- | ---: | ---: | ---: |',
  ]
  for (const item of data.metrics)
    lines.push(
      '| ' +
        [item.task, item.arm, ...item.repetitions.map((trial) => trial.correct + '/' + trial.judged)].join(' | ') +
        ' |',
    )
  lines.push(
    '',
    'Total upstream attempts: ' +
      data.totals.requests +
      '; charged input: ' +
      data.totals.input +
      '; charged completion: ' +
      data.totals.output +
      '; charged USD: ' +
      usd(data.totals.usd) +
      '.',
    '',
    'The immutable manifest, dry-run receipt, append-only attempts/results, exact credential-free payloads and raw provider responses remain under .local/bench/decisions/. The committed fixtures and harness reproduce the rules and scoring without credentials. The synthetic cases reuse several semantic patterns across domains; 120 repetition rows do not constitute 120 independent examples. This is offline development evidence, not deployed acceptance.',
    '',
  )
  return lines
}
export function markdown(data: Report): string {
  return [...qualityTables(data), ...calibrationTables(data), ...repetitionTable(data)].join('\n')
}
