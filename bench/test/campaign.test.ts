import { expect, test } from 'vitest'
import {
  buildContinuity,
  campaignGate,
  campaignTotals,
  stageEpisodes,
  validateCampaign,
  type Campaign,
  type CampaignBuild,
  restoredCampaignErrors,
} from '../src/campaign.ts'
import { starterManifest } from '../src/manifest.ts'
import { replayBatches, compatibleReplay } from '../worker/replay.ts'
import { artifactIdentity } from '../scripts/artifact.ts'
import { validateEvents } from '../src/fixtures.ts'
import type { Scenario, Manifest } from '../src/schema.ts'
import type { Trace, EpisodeResult, RunData } from '../src/results.ts'
import { judgeCase } from '../scripts/judge.ts'
import { campaignReport } from '../src/campaign-report.ts'
import { fingerprint } from '../scripts/artifact.ts'
import type { SemanticVote } from '../src/semantic.ts'

const limits = { maxRequests: 10, maxInputTokens: 10000, maxOutputTokens: 1000 }
const allowance = {
  maxAnswers: 200,
  maxRequests: 2000,
  maxInputTokens: 10000000,
  maxOutputTokens: 500000,
  concurrency: 1,
  maxRequestsPerAnswer: 6,
  phases: { preflight: limits, build: limits, answer: limits, judge: limits },
}
const manifest: Manifest = {
  ...starterManifest(),
  name: 'real',
  campaignId: 'overnight',
  allowance,
  corpus: { path: '.local/bench/corpora/real.json', sha256: 'sealed' },
  scenarioIds: ['real'],
  variants: [{ id: 'native', policy: 'standard', reader: 'deepseek-v4.1-flash' }],
}
const scenario: Scenario = {
  id: 'real',
  family: 'real',
  split: 'development',
  events: [
    { id: 'owner', kind: 'user', text: 'Keep this approved setting.' },
    { id: 'reply', kind: 'assistant', text: 'Recorded.' },
  ],
  probes: ['evidence', 'rationale', 'latest-state', 'negative-constraint', 'abstention'].map((category, at) => ({
    id: `probe${at}`,
    scenarioId: 'real',
    cutoff: 2,
    // SAFETY: category values are verified by the fixed declared schema below through campaign validation.
    category: category as Scenario['probes'][number]['category'],
    question: 'Recall this original setting',
    keys: ['setting'],
    label: {
      requiredClaims: [{ key: 'setting', meaning: 'Keep the setting' }],
      evidenceIds: ['owner'],
      mustAbstain: false,
      prohibitedClaims: [],
      rubric: 'Original owner request',
    },
  })),
}
const campaign: Campaign = {
  schemaVersion: 1,
  name: 'overnight',
  manifests: [{ path: 'manifest', sha256: 'sealed' }],
  allowance,
  judge: { model: 'muse-spark-1.3-contributor', maxOutputTokens: 4096 },
  stages: [
    { id: 'first', manifest: 'real', cutoff: 2, variants: ['native'], build: limits, answer: limits, judge: limits },
  ],
}
const trace: Trace = {
  scope: 'answer',
  phase: 'answer',
  model: 'deepseek-v4.1-flash',
  attempt: 1,
  status: 0,
  input: 300,
  output: 50,
  reservedInput: 300,
  reservedOutput: 50,
  unknownUsage: true,
  request: '',
  response: '',
  at: '',
}

test('campaign validation budgets all phases, selects explicit arms and rejects reversed prefixes or missing judge spend', () => {
  expect(validateCampaign(campaign, [manifest], [scenario])).toEqual([])
  expect(stageEpisodes(campaign.stages[0]!, [manifest], [scenario])).toHaveLength(5)
  expect(
    validateCampaign({ ...campaign, allowance: { ...allowance, maxRequests: 2001 } }, [manifest], [scenario]),
  ).toContain('Campaign exceeds the approved overnight envelope')
  expect(
    validateCampaign(
      { ...campaign, stages: [...campaign.stages, { ...campaign.stages[0]!, id: 'again' }] },
      [manifest],
      [scenario],
    ),
  ).toContain('Non-monotonic checkpoint again')
  expect(
    validateCampaign(
      { ...campaign, stages: [{ ...campaign.stages[0]!, judge: { ...limits, maxRequests: 11 } }] },
      [manifest],
      [scenario],
    ),
  ).toContain('Stages exceed judge envelope')
})
test('restored totals replace reservations and unknown usage or breaches stop the next stage', () => {
  const settled = { ...trace, status: 200, input: 30, output: 10, unknownUsage: false }
  expect(campaignTotals([trace, settled])).toEqual({ requests: 1, input: 30, output: 10 })
  expect(campaignGate([], [], [trace]).reasons).toContain('Unknown or unsettled usage')
  expect(campaignGate([], [], [{ ...settled, output: 51 }]).reasons).toContain('Provider reservation breach')
})
test('cold, extension and reuse receipts prove monotonic memory and reject extra calls on reuse', () => {
  const base: CampaignBuild = {
    episodeId: 'probe',
    actor: 'tree',
    stage: 1,
    buildMs: 1,
    attempts: [1],
    build: {
      status: 'cold',
      sourceCount: 2,
      previousSourceCount: 0,
      newlyProcessedSourceCount: 2,
      memorySize: 2,
      viewThrough: 1,
    },
  }
  const extend: CampaignBuild = {
    ...base,
    stage: 2,
    build: {
      ...base.build,
      status: 'extended',
      sourceCount: 4,
      previousSourceCount: 2,
      newlyProcessedSourceCount: 2,
      memorySize: 4,
      viewThrough: 3,
    },
  }
  const reuse: CampaignBuild = {
    ...extend,
    attempts: [],
    build: { ...extend.build, status: 'reused', previousSourceCount: 4, newlyProcessedSourceCount: 0 },
  }
  expect(buildContinuity([base, extend, reuse])).toEqual([])
  expect(buildContinuity([base, extend, { ...reuse, attempts: [2] }])).toContain(
    'Reused memory issued construction calls or reprocessed source',
  )
  expect(buildContinuity([base, { ...extend, build: { ...extend.build, previousSourceCount: 0 } }])).toContain(
    'Memory build did not extend its exact prior prefix',
  )
})
test('bounded replay never splits calls and results; modified prefixes and settings invalidate reuse', () => {
  const events = [
    ...scenario.events,
    { id: 'call', kind: 'tool-call' as const, callId: 'c', toolName: 'inspect', text: '{}' },
    {
      id: 'result',
      kind: 'tool-result' as const,
      callId: 'c',
      toolName: 'inspect',
      text: 'recorded result'.repeat(30),
    },
    { id: 'last', kind: 'assistant' as const, text: 'Done' },
  ]
  const batches = replayBatches(events, 1400)
  for (const batch of batches)
    expect(validateEvents(batch.flatMap((group) => events.filter((event) => group.ids.includes(event.id))))).toEqual([])
  expect(() => replayBatches(events, 100)).toThrow('batch limit')
  const config = {
    identity: 'tree',
    manifest,
    policy: 'standard' as const,
    writer: 'deepseek-v4.1-flash',
    events: scenario.events,
  }
  expect(compatibleReplay(config, { ...config, events })).toBe(true)
  expect(
    compatibleReplay(config, { ...config, events: [{ ...events[0]!, text: 'changed' }, ...events.slice(1)] }),
  ).toBe(false)
  const resolved = {
    manifest,
    sourceHash: 'code',
    corpusHash: 'corpus',
    runId: 'run',
    mode: 'live' as const,
    createdAt: '',
    scenarios: [scenario],
  }
  const id = artifactIdentity(resolved, 'real', manifest.variants[0]!)
  expect(
    artifactIdentity(
      { ...resolved, manifest: { ...manifest, campaignId: 'different' } },
      'real',
      manifest.variants[0]!,
    ),
  ).not.toBe(id)
})
test('judge payload contains exact audited ranges and original answers without arm or model identities', () => {
  const label = scenario.probes[0]!.label!
  const item = {
    caseId: 'blind',
    question: 'What?',
    category: 'evidence' as const,
    label: { ...label, evidenceRanges: [{ id: 'owner', offsetBytes: 0, endBytes: 4 }] },
    prefix: scenario.events,
    delivered: [],
    rawAnswer: '{bad original output}',
  }
  expect(judgeCase(item).rawAnswer).toBe('{bad original output}')
  expect(judgeCase(item).evidence[0]).toMatchObject({ id: 'owner', ranges: [{ text: 'Keep' }] })
  expect(JSON.stringify(judgeCase(item))).not.toContain('deepseek')
  expect(() => judgeCase({ ...item, label: { ...label, evidenceIds: ['future'] } })).toThrow('prefix')
})

function reportData(): RunData {
  const variants: Manifest['variants'] = [
    ...manifest.variants,
    { id: 'optchat.qwen', policy: 'optchat', writer: 'qwen3.8-flash', reader: 'deepseek-v4.1-flash' },
  ]
  const resolved = {
    manifest: { ...manifest, variants },
    sourceHash: 'code',
    corpusHash: 'corpus',
    runId: 'overnight',
    mode: 'live' as const,
    createdAt: '',
    scenarios: [scenario],
  }
  const results: EpisodeResult[] = scenario.probes.flatMap((probe) =>
    variants.map((variant) => ({
      id: `${probe.id}.${variant.id}`,
      variant: variant.id,
      category: probe.category,
      status: 'completed' as const,
      answer: { claims: [], evidenceIds: [], abstain: true },
      score: {
        correct: false,
        evidenceComplete: false,
        evidenceValid: false,
        abstentionCorrect: true,
        unsupported: false,
      },
      malformed: false,
      futureLeakage: false,
      unauthorizedReads: false,
      forbiddenEndorsement: false,
      deliveredIds: [],
      detail: '',
      timing: { episodeMs: 12, answerMs: 10 },
    })),
  )
  const semanticVotes: SemanticVote[] = results.flatMap((result) =>
    (['machine', 'human'] as const).map((kind) => ({
      voteId: `${result.id}.${kind}`,
      packetId: 'packet',
      caseId: result.id,
      kind,
      reviewer: kind,
      rationale: 'Checked',
      evidenceIds: [],
      searchSupported: false,
      resolves: [],
      at: '',
      runId: 'overnight',
      sourceHash: 'code',
      corpusHash: 'corpus',
      episodeId: result.id,
      resultHash: '',
      packetHash: '',
      score: {
        factualCorrect: result.variant !== 'native',
        evidenceComplete: true,
        evidenceValid: true,
        abstentionCorrect: true,
        unsupported: false,
      },
    })),
  )
  return {
    resolved,
    results,
    semanticVotes,
    traces: [
      {
        ...trace,
        scope: 'overnight.probe0.native',
        stage: 1,
        status: 200,
        unknownUsage: false,
        request: '{"messages":[{"role":"user","content":"real context"}]}',
        input: 30,
        output: 10,
      },
    ],
  }
}
test('campaign report compares paired outcomes, exposes sent context and withholds unresolved human gains', () => {
  const data = reportData()
  const selected = { ...campaign, stages: [{ ...campaign.stages[0]!, variants: ['native', 'optchat.qwen'] }] }
  const report = campaignReport(selected, [data.resolved.manifest], data)
  expect(report.comparisons[0]).toMatchObject({ humanResolved: { gains: 5, losses: 0, gainPoints: 100 } })
  expect(report.rows.find((row) => row.episodeId === 'probe0.native')?.renderedContext[0]).toMatchObject({
    messageCount: 1,
    serializedMessagesBytes: 42,
    reportedPromptTokens: 30,
  })
  const machineOnly = campaignReport(selected, [data.resolved.manifest], {
    ...data,
    semanticVotes: (data.semanticVotes ?? []).filter((v) => v.kind === 'machine'),
  })
  expect(machineOnly.comparisons[0]).toMatchObject({
    humanResolved: { gains: 0, complete: false },
    machineDiagnostic: { gains: 5 },
  })
  const unsafe = campaignReport(selected, [data.resolved.manifest], {
    ...data,
    results: data.results.map((r) => ({ ...r, futureLeakage: r.variant === 'optchat.qwen' })),
  })
  expect(unsafe.comparisons[0]?.machineDiagnostic.gains).toBe(0)
  expect(unsafe.comparisons[0]?.humanResolved.leakageIncrease).toBe(5)
})
test('resume rejects a passed receipt when restored usage or sealed review is missing', () => {
  const data = reportData()
  const receipt = {
    campaignHash: fingerprint(campaign),
    stage: 'first',
    at: '',
    passed: true,
    reasons: [],
    planned: 5,
    completed: 5,
    total: { requests: 1, input: 30, output: 10 },
  }
  expect(restoredCampaignErrors(campaign, [data.resolved.manifest], data, [], [receipt])).toEqual([])
  expect(
    restoredCampaignErrors(campaign, [data.resolved.manifest], { ...data, traces: [trace] }, [], [receipt]),
  ).toContain('Recorded stage first does not match restored operational evidence')
  expect(
    restoredCampaignErrors(campaign, [data.resolved.manifest], { ...data, semanticVotes: [] }, [], [receipt]),
  ).toContain('Recorded stage first lacks sealed machine review')
})
