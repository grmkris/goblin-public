import { arms, tasks, type Fixture, type Row, type Attempt } from './schema.ts'
import type { Manifest } from './manifest.ts'
import { summarize } from './scoring.ts'
import { totals } from './budget.ts'

const pct = (value: number | null): string => (value === null ? 'n/a' : (100 * value).toFixed(1) + '%')
const usd = (value: number | null): string => (value === null ? 'unknown' : '$' + value.toFixed(6))
export function combineRows(groups: readonly (readonly Row[])[]): Row[] {
  const merged = new Map<string, Row>()
  for (const rows of groups) for (const row of rows) merged.set([row.id, row.arm, row.repetition].join('/'), row)
  return [...merged.values()]
}
export function reportData(
  manifest: Manifest,
  fixtures: readonly Fixture[],
  rows: readonly Row[],
  attempts: readonly Attempt[],
  sources: readonly Manifest[] = [manifest],
) {
  const metrics = tasks.flatMap((task) =>
    arms.map((arm) => ({
      task,
      arm,
      ...summarize(
        fixtures,
        rows.filter((row) => row.task === task && row.arm === arm),
        manifest.frozenThresholds === undefined ? undefined : manifest.frozenThresholds[task][arm],
      ),
    })),
  )
  return {
    runId: manifest.runId,
    fixtureHash: manifest.fixtureHash,
    sourceHash: manifest.sourceHash,
    thresholdSource: manifest.thresholdSource ?? null,
    fixtureCount: fixtures.length,
    taskCounts: tasks.map((task) => ({ task, count: fixtures.filter((fixture) => fixture.task === task).length })),
    sources: sources.map((source) => ({ runId: source.runId, sourceHash: source.sourceHash, limits: source.limits })),
    attempts: [...new Map(attempts.map((attempt) => [attempt.id, attempt])).values()],
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
    'Included sources: ' +
      data.sources.map((source) => source.runId + ' (' + source.sourceHash + ')').join('; ') +
      '. Later included rows supersede earlier matching arm/case/repetition rows; all original attempts and costs remain in the ledger.',
    '',
    data.fixtureCount +
      ' synthetic labelled cases: ' +
      data.taskCounts.map((item) => item.task + '=' + item.count).join(', ') +
      '. Three repetitions share the frozen fixture set. Labels never enter provider evidence.',
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
    'Calibration uses the probability of the chosen answer against correctness. Rules have deterministic 0/1 outputs; these are policy scores, not learned confidence. Positive classes are candidate inclusion, any durable brief type, highlight, and an organization action (suggest/reuse). ' +
      (data.thresholdSource === null
        ? 'Each threshold maximizes positive precision subject to >=70% recall; ties favor recall, then the higher threshold. Thresholds were fit on this development set.'
        : 'Thresholds were frozen from development run ' +
          data.thresholdSource +
          ' and applied unchanged; no held-out refitting.') +
      ' Independent owner-label validation is required before automatic behavior.',
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
function attemptTable(data: Report): string[] {
  const lines = [
    '',
    '| Arm | Upstream attempts | HTTP errors | Timeouts | Reservation breaches | Charged USD |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const arm of arms) {
    const calls = data.attempts.filter((attempt) => attempt.arm === arm)
    lines.push(
      '| ' +
        [
          arm,
          calls.length,
          calls.filter((call) => call.status >= 400).length,
          calls.filter((call) => call.error === 'timeout').length,
          calls.filter((call) => call.error === 'reservation-breach').length,
          usd(calls.reduce((sum, call) => sum + call.costUsd, 0)),
        ].join(' | ') +
        ' |',
    )
  }
  lines.push(
    '',
    'The quality table counts affected cases; this table counts upstream requests. Campaign totals include superseded diagnostic attempts. Charged USD uses the declared budget rates and is not a CLIProxy invoice. No credentials are included in artifacts.',
  )
  return lines
}
export function markdown(data: Report): string {
  return [...qualityTables(data), ...calibrationTables(data), ...repetitionTable(data), ...attemptTable(data)].join(
    '\n',
  )
}
