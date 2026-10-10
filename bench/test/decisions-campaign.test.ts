import { Schema } from 'effect'
import { expect, it } from 'vitest'
import { models, Manifest } from '../src/decisions/manifest.ts'
import type { Attempt } from '../src/decisions/schema.ts'
import { admission } from '../src/decisions/budget.ts'
import { decisionFixtures } from '../src/decisions/fixtures.ts'
import { plannedBatches, plan, requestBody } from '../src/decisions/runner.ts'

const routes = models('fake')
const manifest: Manifest = {
  schemaVersion: 1,
  runId: 'second',
  fixtureHash: 'fake',
  sourceHash: 'fake',
  repetitions: 3,
  batchSize: 2,
  prompt: 'fixed',
  questions: {},
  models: routes,
  campaign: { id: 'tonight', maxUsd: 3.5 },
  limits: {
    maxRequests: 2000,
    maxUsd: 3,
    maxInput: 8000000,
    maxOutput: 2000000,
    perCallInput: 16000,
    perCallOutput: 1024,
  },
}
const model = routes.find((route) => route.arm === 'cheap-llm')
if (model === undefined) throw new Error('Missing model')
const previous: Attempt = {
  id: 'first.1',
  runId: 'first',
  campaignId: 'tonight',
  arm: 'cheap-llm',
  fixtureId: 'case',
  repetition: 1,
  phase: 'settle',
  reservedInput: 100,
  reservedOutput: 100,
  input: 100,
  output: 100,
  costUsd: 3.4999,
  status: 200,
  error: null,
  usageKnown: true,
  latencyMs: 1,
}
it('enforces the nightly ceiling across immutable manifests and the individual manifest ceiling independently', () => {
  expect(admission(manifest, [previous], model, 100, 100)).toBe('campaign-budget-ceiling')
  expect(admission(manifest, [{ ...previous, campaignId: 'yesterday' }], model, 100, 100)).toBeNull()
  expect(admission(manifest, [{ ...previous, runId: 'second', costUsd: 2.9999 }], model, 100, 100)).toBe(
    'budget-ceiling',
  )
  expect(admission(manifest, [{ ...previous, campaignId: 'yesterday', phase: 'reserve' }], model, 100, 100)).toBe(
    'unfinished-attempt',
  )
  expect(admission(manifest, [{ ...previous, campaignId: 'yesterday', usageKnown: false }], model, 100, 100)).toBe(
    'unknown-usage',
  )
  expect(() =>
    Schema.decodeUnknownSync(Manifest)({ ...manifest, campaign: { id: 'tonight', maxUsd: 3.5001 } }),
  ).toThrow()
  expect(() =>
    Schema.decodeUnknownSync(Manifest)({ ...manifest, limits: { ...manifest.limits, maxUsd: 3.01 } }),
  ).toThrow()
})
it('seals completed repetition exclusions so planning and execution request only missing rows', () => {
  const fixtures = decisionFixtures.slice(0, 2)
  const first = fixtures[0]
  if (first === undefined) throw new Error('Missing fixture')
  const remaining: Manifest = {
    ...manifest,
    selectedArms: ['cheap-llm'],
    excludeRows: fixtures
      .map<{ id: string; arm: 'cheap-llm'; repetition: number }>(({ id }) => ({ id, arm: 'cheap-llm', repetition: 1 }))
      .concat([{ id: first.id, arm: 'cheap-llm', repetition: 2 }]),
  }
  const batches = plannedBatches(remaining, fixtures, 'cheap-llm')
  expect(batches.map((batch) => [batch.repetition, batch.fixtures.length])).toEqual([
    [2, 1],
    [3, 2],
  ])
  expect(plan(remaining, fixtures).requests).toBe(2)
  expect(batches[0]?.selected.map((fixture) => fixture.id)).toEqual([fixtures[1]?.id])
})
it('pins direct provider credentials and uses native noul questions for Jev without gateway headers', () => {
  const jev = routes.find((route) => route.arm === 'jev')
  if (jev === undefined) throw new Error('Missing Jev')
  const batch = plannedBatches(manifest, decisionFixtures.slice(0, 2), 'jev')[0]
  if (batch === undefined) throw new Error('Missing batch')
  expect(jev).toMatchObject({
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    model: 'jev-1.13.0',
    keyEnv: 'JEV_API_KEY',
  })
  expect(requestBody(batch, jev, 1024)).toContain('"type":"noul"')
  expect(routes.find((route) => route.arm === 'openai-decisions')).toMatchObject({
    endpoint: 'https://api.openai.com/v1/decisions',
    keyEnv: 'OPENAI_DECISIONS_API_KEY',
  })
})
