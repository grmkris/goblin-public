import { describe, expect, it } from 'vitest'
import { dataset, validateScenario } from '../src/fixtures.ts'
import { decodeManifest, starterManifest, validateManifest } from '../src/manifest.ts'
import { artifactIdentity } from '../scripts/identity.ts'
import { plan } from '../src/plan.ts'
import { groundTruth, scoreProbe } from '../src/scoring.ts'

const staging = dataset()[0]!
const first = staging.probes[0]!

describe('bounded experiment planning', () => {
  it('shares the OptChat tree with source search and keeps the starter matrix unchanged', () => {
    const baseline = { id: 'baseline', policy: 'optchat' as const, writer: 'qwen3.8-flash', reader: 'grok-4.7' }
    const candidate = { ...baseline, id: 'candidate', policy: 'optchat-search' as const }
    const manifest = { ...starterManifest(), scenarioIds: ['staging'], variants: [baseline, candidate] }
    expect(validateManifest(manifest)).toEqual([])
    expect(plan(manifest)).toMatchObject({ variants: 2, answers: 8, checkpoints: 2 })
    const resolved = {
      manifest,
      sourceHash: 'source',
      corpusHash: 'corpus',
      runId: 'run',
      mode: 'live' as const,
      createdAt: '',
    }
    expect(artifactIdentity(resolved, 'staging', baseline)).toBe(artifactIdentity(resolved, 'staging', candidate))
    expect(plan(starterManifest()).variants).toBe(8)
    expect(validateManifest({ ...manifest, variants: [{ ...candidate, writer: undefined }] })).toContain(
      'candidate needs a writer',
    )
  })
  it('declares 96 paired episodes and preserves source tool pairs', () => {
    expect(validateManifest(decodeManifest(starterManifest()))).toEqual([])
    expect(plan()).toMatchObject({ scenarios: 3, probes: 12, variants: 8, answers: 96 })
    for (const scenario of dataset()) expect(validateScenario(scenario)).toEqual([])
  })
  it('rejects held-out mixing and a mislabeled native writer', () => {
    const manifest = starterManifest()
    expect(validateManifest({ ...manifest, scenarioIds: ['verification'] })).toContain('split mismatch verification')
    expect(
      validateManifest({
        ...manifest,
        variants: [{ id: 'bad', policy: 'standard', reader: 'glm-5.3', writer: 'other' }],
      }),
    ).not.toEqual([])
  })
})

describe('prefix-only deterministic grading', () => {
  it('ignores future decisions and unsupported assistant claims', () => {
    expect(groundTruth(staging, first)).toEqual([{ key: 'staging-retries', value: '7', evidenceId: 'staging.e16' }])
    expect(groundTruth(staging, { ...first, cutoff: 512 })[0]?.value).toBe('9')
    const evidence = dataset()[1]!
    expect(groundTruth(evidence, evidence.probes[0]!)[0]?.value).toBe('failed: missing APP_TOKEN')
  })
  it('requires exact claims and evidence actually delivered from the allowed prefix', () => {
    const answer = { claims: [{ key: 'staging-retries', value: '7' }], evidenceIds: ['staging.e16'], abstain: false }
    expect(scoreProbe(staging, first, answer, ['staging.e16']).correct).toBe(true)
    expect(scoreProbe(staging, first, answer, []).correct).toBe(false)
    expect(
      scoreProbe(staging, first, { ...answer, claims: [{ key: 'staging-retries', value: '17' }] }, ['staging.e16'])
        .unsupported,
    ).toBe(true)
    expect(
      scoreProbe(staging, first, { ...answer, evidenceIds: ['staging.e300'] }, ['staging.e300']).evidenceValid,
    ).toBe(false)
  })
})
