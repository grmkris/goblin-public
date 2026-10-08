import { describe, expect, it } from 'vitest'
import { Schema } from 'effect'
import raw from '../fixtures/decisions-heldout.json'
import { decodeFixtures, defaultFixtureFile, normalizeLabel } from '../src/decisions/fixtures.ts'
import { Manifest, freezeThresholds, models } from '../src/decisions/manifest.ts'
import { tasks } from '../src/decisions/schema.ts'
import { questionsFor } from '../src/decisions/questions.ts'
import { evaluateThreshold, summarize } from '../src/decisions/scoring.ts'
import { localRow, plan } from '../src/decisions/runner.ts'
import { reportData, markdown } from '../src/decisions/report.ts'

const fixtures = decodeFixtures(raw)
const manifest: Manifest = {
  schemaVersion: 1,
  runId: 'heldout-test',
  fixtureFile: 'bench/fixtures/decisions-heldout.json',
  fixtureHash: 'heldout-fixtures',
  sourceHash: 'source',
  repetitions: 3,
  batchSize: 2,
  selectedArms: ['rules', 'critic', 'cheap-llm', 'jev'],
  prompt: 'test',
  questions: {},
  models: models('synthetic-account'),
  limits: {
    maxRequests: 2000,
    maxUsd: 3,
    maxInput: 8_000_000,
    maxOutput: 2_000_000,
    perCallInput: 16_000,
    perCallOutput: 1024,
  },
}

describe('independent fixture and frozen threshold boundaries', () => {
  it('preserves all 100 independent labels and validates the offered vocabulary', () => {
    expect(fixtures).toEqual(raw)
    expect(fixtures).toHaveLength(100)
    expect(fixtures.every((fixture) => fixture.id.startsWith('heldout-'))).toBe(true)
    for (const task of tasks) expect(fixtures.filter((fixture) => fixture.task === task)).toHaveLength(25)
    for (const fixture of fixtures)
      for (const [name, label] of Object.entries(fixture.expected))
        expect(questionsFor(fixture)[name]?.options).toContain(label)
    expect(normalizeLabel('reuse-existing:tax')).toBe('reuse-existing:tax')
    expect(() => normalizeLabel('made-up-label')).toThrow('Unreviewed fixture label')
    expect(() => decodeFixtures([{ ...raw[0], expected: {} }])).toThrow('Incomplete fixture labels')
    expect(() => decodeFixtures([raw[0], raw[0]])).toThrow('Duplicate fixture id')
  })
  it('keeps old manifests compatible and plans the selected independent set', () => {
    const { fixtureFile: _fixtureFile, ...old } = manifest
    expect(Schema.decodeUnknownSync(Manifest)(old).fixtureFile ?? defaultFixtureFile).toBe(
      'bench/fixtures/decisions.json',
    )
    expect(Schema.decodeUnknownSync(Manifest)(manifest).fixtureFile).toBe(manifest.fixtureFile)
    const output = plan(manifest, fixtures)
    expect(output.estimates.find((item) => item.arm === 'cheap-llm')?.requests).toBe(150)
    expect(output.estimates.find((item) => item.arm === 'jev')?.requests).toBe(150)
    const report = reportData(manifest, fixtures, [], [])
    expect(markdown(report)).toContain('100 synthetic labelled cases')
    expect(report.taskCounts.every((item) => item.count === 25)).toBe(true)
  })
  it('applies the development cutoff unchanged even when held-out recall falls below 70 percent', () => {
    const frozen = freezeThresholds([{ task: 'context-relevance', arm: 'jev', threshold: { value: 0.69 } }])
    expect(frozen['context-relevance']['jev']).toBe(0.69)
    expect(frozen['context-relevance']['clef']).toBeNull()
    const result = evaluateThreshold(
      [
        { probability: 0.8, positive: true },
        { probability: 0.6, positive: true },
        { probability: 0.9, positive: false },
      ],
      frozen['context-relevance']['jev'] ?? 0,
    )
    expect(result).toMatchObject({ value: 0.69, precision: 0.5, recall: 0.5, falsePositive: 1, falseNegative: 1 })
    const item = fixtures[0]
    if (item === undefined) throw new Error('Missing held-out fixture')
    expect(summarize([item], [localRow(item, 'jev', 1)], 0.69).threshold?.value).toBe(0.69)
    expect(summarize([item], [localRow(item, 'clef', 1)], null).threshold).toBeNull()
  })
})
