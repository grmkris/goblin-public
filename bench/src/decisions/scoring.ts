import type { Fixture, Row, Task } from './schema.ts'
import { chosen } from './questions.ts'

export interface Observation {
  readonly probability: number
  readonly positive: boolean
}
const positiveOptions = (task: Task, options: readonly string[]): readonly string[] => {
  switch (task) {
    case 'context-relevance':
      return ['yes']
    case 'brief-update':
      return options.filter((option) => option !== 'none')
    case 'attention-triage':
      return ['highlight']
    case 'separate-work':
      return options.filter((option) => !['continue-here', 'uncertain'].includes(option))
  }
}
const detailRows = (fixture: Fixture, row: Row) =>
  Object.entries(fixture.expected).map(([name, expected]) => {
    const distribution = row.answers?.[name] ?? {}
    const value = chosen(distribution)
    const options = positiveOptions(fixture.task, Object.keys(distribution))
    return {
      name,
      expected,
      value,
      correct: value === expected,
      confidence: distribution[value] ?? 0,
      probability: options.reduce((sum, option) => sum + (distribution[option] ?? 0), 0),
      positive: options.includes(expected),
    }
  })
const primaryRows = (fixture: Fixture, details: ReturnType<typeof detailRows>) => {
  const name =
    fixture.task === 'context-relevance'
      ? null
      : fixture.task === 'brief-update'
        ? 'entry'
        : fixture.task === 'attention-triage'
          ? 'attention'
          : 'organization'
  return name === null
    ? details.filter((item) => item.name !== 'none-relevant')
    : details.filter((item) => item.name === name)
}
export function score(fixture: Fixture, row: Row) {
  if (row.answers === null || row.error !== null) return null
  const details = detailRows(fixture, row)
  const primary = primaryRows(fixture, details)
  return {
    correct: details.every((item) => item.correct),
    questionCorrect: details.filter((item) => item.correct).length,
    questionTotal: details.length,
    details,
    observations: primary.map(({ probability, positive }) => ({ probability, positive })),
    wrongContext:
      fixture.task === 'context-relevance'
        ? primary.filter((item) => item.expected === 'no' && item.value === 'yes').length
        : 0,
    wrongDecision:
      fixture.task === 'brief-update'
        ? primary.filter((item) => item.value === 'decision' && item.expected !== 'decision').length
        : 0,
    missedHighlight:
      fixture.task === 'attention-triage'
        ? primary.filter((item) => item.expected === 'highlight' && item.value !== 'highlight').length
        : 0,
    unnecessaryHighlight:
      fixture.task === 'attention-triage'
        ? primary.filter((item) => item.expected !== 'highlight' && item.value === 'highlight').length
        : 0,
    unnecessarySuggestion:
      fixture.task === 'separate-work'
        ? primary.filter((item) => !item.positive && !['continue-here', 'uncertain'].includes(item.value)).length
        : 0,
  }
}

/** Binary action probability is evaluated against truth, never against P(expected). */
export function threshold(observations: readonly Observation[]) {
  const positive = observations.filter((item) => item.positive).length
  if (positive === 0) return null
  const thresholds = [...new Set([0, 1, ...observations.map((item) => item.probability)])].toSorted((a, b) => b - a)
  const options = thresholds.flatMap((value) => {
    const selected = observations.filter((item) => item.probability >= value)
    const truePositive = selected.filter((item) => item.positive).length
    const recall = truePositive / positive
    return selected.length === 0 || recall < 0.7
      ? []
      : [{ value, precision: truePositive / selected.length, recall, positive, selected: selected.length }]
  })
  return options.toSorted((a, b) => b.precision - a.precision || b.recall - a.recall || b.value - a.value)[0] ?? null
}
export function calibration(items: readonly { confidence: number; correct: boolean }[]) {
  return Array.from({ length: 5 }, (_, index) => {
    const lower = index * 0.2
    const upper = (index + 1) * 0.2
    const selected = items.filter(
      (item) => item.confidence >= lower && (index === 4 ? item.confidence <= upper : item.confidence < upper),
    )
    return {
      lower,
      upper,
      count: selected.length,
      correctness: selected.length === 0 ? null : selected.filter((item) => item.correct).length / selected.length,
      meanConfidence:
        selected.length === 0 ? null : selected.reduce((sum, item) => sum + item.confidence, 0) / selected.length,
    }
  })
}
const quantile = (items: readonly number[], fraction: number): number | null =>
  items.toSorted((a, b) => a - b)[Math.max(0, Math.ceil(items.length * fraction) - 1)] ?? null
const scoreRows = (fixtures: readonly Fixture[], rows: readonly Row[]) =>
  rows.flatMap((row) => {
    const fixture = fixtures.find((item) => item.id === row.id)
    const result = fixture === undefined ? null : score(fixture, row)
    return result === null ? [] : [result]
  })
const quality = (scored: ReturnType<typeof scoreRows>) => {
  return {
    judged: scored.length,
    correct: scored.filter((item) => item.correct).length,
    accuracy: scored.length === 0 ? null : scored.filter((item) => item.correct).length / scored.length,
    questionAccuracy:
      scored.length === 0
        ? null
        : scored.reduce((sum, item) => sum + item.questionCorrect, 0) /
          scored.reduce((sum, item) => sum + item.questionTotal, 0),
    wrongContext: scored.reduce((sum, item) => sum + item.wrongContext, 0),
    wrongDecision: scored.reduce((sum, item) => sum + item.wrongDecision, 0),
    missedHighlight: scored.reduce((sum, item) => sum + item.missedHighlight, 0),
    unnecessaryHighlight: scored.reduce((sum, item) => sum + item.unnecessaryHighlight, 0),
    unnecessarySuggestion: scored.reduce((sum, item) => sum + item.unnecessarySuggestion, 0),
  }
}
const operations = (rows: readonly Row[]) => {
  const measured = rows.filter((row) => row.route !== 'skipped')
  return {
    planned: rows.length,
    providerErrors: rows.filter(
      (row) => row.route === 'model' && row.error !== null && row.error !== 'invalid-answer' && row.error !== 'timeout',
    ).length,
    timeouts: rows.filter((row) => row.error === 'timeout').length,
    invalidAnswers: rows.filter((row) => row.error === 'invalid-answer').length,
    skipped: rows.filter((row) => row.route === 'skipped').length,
    p50Ms: quantile(
      measured.map((row) => row.latencyMs),
      0.5,
    ),
    p95Ms: quantile(
      measured.map((row) => row.latencyMs),
      0.95,
    ),
    chargedUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
    actualCostUsd: measured.some((row) => row.actualCostUsd === null)
      ? null
      : measured.reduce((sum, row) => sum + (row.actualCostUsd ?? 0), 0),
    ruleDecisions: rows.filter((row) => row.route === 'rules').length,
  }
}
export function summarize(fixtures: readonly Fixture[], rows: readonly Row[]) {
  const scored = scoreRows(fixtures, rows)
  return {
    ...quality(scored),
    ...operations(rows),
    threshold: threshold(scored.flatMap((item) => item.observations)),
    calibration: calibration(scored.flatMap((item) => item.details)),
    repetitions: [1, 2, 3].map((repetition) => {
      const trial = scoreRows(
        fixtures,
        rows.filter((row) => row.repetition === repetition),
      )
      return { repetition, judged: trial.length, correct: trial.filter((item) => item.correct).length }
    }),
  }
}
