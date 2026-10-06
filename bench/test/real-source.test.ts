import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { Schema } from 'effect'
import { expect, test } from 'vitest'
import { Corpus } from '../src/corpus.ts'
import { importClaude, sourceCheckpoints } from '../src/import.ts'
import { publicEvents } from '../src/protocol.ts'
import { replayGroups } from '../worker/replay.ts'
import { episodes } from '../src/plan.ts'
import { canaryManifest, validateManifest, starterManifest } from '../src/manifest.ts'
import { redactor } from '../scripts/redaction.ts'
import { scoreProbe } from '../src/scoring.ts'
import { Manifest } from '../src/schema.ts'
import { EpisodeResult, Resolved, Trace } from '../src/results.ts'
import { accounting, summary } from '../src/report.ts'
import { applyReview, Review } from '../src/review.ts'
import { stageGate } from '../src/stages.ts'
import { answerMetrics, efficiency } from '../src/metrics.ts'

const dir = resolve(import.meta.dirname, '../../.local/bench/corpora/claude-canary')
const sourcePath = resolve(dir, 'source.jsonl')
const runPath = resolve(dir, '../../runs/real-claude-canary-04/result.json')
test.skipIf(!existsSync(runPath))('unreviewed real answers have no accuracy and runtime failures stay separate', () => {
  const data = Schema.decodeUnknownSync(
    Schema.Struct({ resolved: Resolved, results: Schema.Array(EpisodeResult), traces: Schema.Array(Trace) }),
  )(JSON.parse(readFileSync(runPath, 'utf8')))
  const scores = Object.values(summary(data))
  expect(scores.every((score) => score.accuracy === null)).toBe(true)
  expect(scores.reduce((n, score) => n + score.scoredAnswers, 0)).toBe(0)
  expect(scores.reduce((n, score) => n + score.completedAnswers, 0)).toBe(9)
  expect(scores.reduce((n, score) => n + score.runtimeFailures, 0)).toBe(27)
  expect(scores.reduce((n, score) => n + score.pendingReviews, 0)).toBe(9)
  expect(accounting(data)).toEqual({
    requests: 51,
    successfulRequests: 49,
    failedRequests: 2,
    unsettledRequests: 0,
    unknownUsageRequests: 2,
    chargedTokens: { input: 363339, output: 8479 },
    reportedTokens: { input: 293308, output: 4393 },
  })
})
const reviewsPath = resolve(runPath, '../reviews.jsonl')
test.skipIf(!existsSync(runPath) || !existsSync(reviewsPath))(
  'real semantic reviews preserve strict failures and coverage',
  () => {
    const data = Schema.decodeUnknownSync(
      Schema.Struct({ resolved: Resolved, results: Schema.Array(EpisodeResult), traces: Schema.Array(Trace) }),
    )(JSON.parse(readFileSync(runPath, 'utf8')))
    const reviews = readFileSync(reviewsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => Schema.decodeUnknownSync(Review)(JSON.parse(line)))
    const results = data.results.map((result) => {
      const review = reviews.findLast((item) => item.episodeId === result.id)
      return review === undefined ? result : applyReview(data.resolved, result, review)
    })
    const scores = Object.values(summary({ ...data, results }))
    expect(scores.reduce((n, score) => n + score.scoredAnswers, 0)).toBe(9)
    expect(scores.reduce((n, score) => n + score.correct, 0)).toBe(3)
    expect(scores.reduce((n, score) => n + score.runtimeFailures, 0)).toBe(27)
    expect(scores.reduce((n, score) => n + score.pendingReviews, 0)).toBe(0)
  },
)
test.skipIf(!existsSync(sourcePath))('real canary preserves provider-default thinking for GLM compatibility', () => {
  const original = Schema.decodeUnknownSync(Manifest)(JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')))
  const scenarioId = original.scenarioIds[0]
  if (original.corpus === undefined || scenarioId === undefined) throw new Error('Missing real canary manifest')
  const manifest = canaryManifest('claude-canary', scenarioId, original.corpus)
  expect(manifest.transport).toEqual({ contextWindowTokens: 131_072, thinking: 'provider-default' })
  expect(manifest.variants).toHaveLength(6)
})
// Optional private regression uses the actual frozen session. CI never substitutes a generated conversation.
test.skipIf(!existsSync(sourcePath))(
  'real Claude source: visible blocks, parallel calls, checkpoint pairs and host-only labels',
  () => {
    const source = readFileSync(sourcePath, 'utf8')
    const imported = importClaude(source, redactor([]).redact)
    expect(imported.events).toHaveLength(1015)
    expect(imported.events.filter((event) => event.kind === 'tool-call')).toHaveLength(425)
    expect(imported.events.filter((event) => event.kind === 'tool-result')).toHaveLength(425)
    const checkpoints = sourceCheckpoints(imported.events, [16_000, 32_000])
    expect(checkpoints.map((checkpoint) => checkpoint.cutoff)).toEqual([22, 32])
    const corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(readFileSync(resolve(dir, 'corpus.json'), 'utf8')))
    const scenario = corpus.scenarios[0]
    if (scenario === undefined) throw new Error('Missing imported scenario')
    const manifest = {
      ...starterManifest(),
      scenarioIds: [scenario.id],
      variants: starterManifest().variants.slice(0, 6),
    }
    expect(episodes(manifest, [scenario])).toHaveLength(36)
    expect(
      validateManifest({ ...manifest, allowance: { ...manifest.allowance, maxAnswers: 35 } }, [scenario]),
    ).toContain('answer plan exceeds allowance')
    const groups = replayGroups(publicEvents(scenario.events.slice(0, 32)))
    expect(groups.length).toBeLessThan(32)
    const parallel = groups.find((group) => group.ids.includes('claude.l96.b0'))
    expect(parallel?.ids).toEqual(['claude.l96.b0', 'claude.l97.b0'])
    const message = parallel?.entry.model?.[0]
    if (message?.role !== 'assistant') throw new Error('Missing replay assistant')
    expect(message.content.filter((block) => block.type === 'toolCall').map((block) => block.arguments)).toEqual(
      scenario.events.filter((event) => parallel?.ids.includes(event.id)).map((event) => event.arguments),
    )
    expect(JSON.stringify(publicEvents(scenario.events))).not.toContain('requiredClaims')
    const probe = scenario.probes[0]
    if (probe === undefined) throw new Error('Missing grounded probe')
    expect(scoreProbe(scenario, probe, { claims: [], evidenceIds: [], abstain: false }, []).correct).toBe(false)
    const truncated = source.split('\n').slice(0, 28).join('\n')
    expect(() => importClaude(truncated, (text) => text)).toThrow('unmatched tool calls')
    expect(() => importClaude('{broken JSON}', (text) => text)).toThrow()
  },
)

const pilotPath = resolve(dir, '../../runs/optchat-search-pilot-01-live/attempts.jsonl')
test.skipIf(!existsSync(pilotPath))(
  'observed Qwen usage outside max_tokens would now fail preflight and stop admission',
  async () => {
    const { exceededReservation } = await import('../src/budget.ts')
    const traces = readFileSync(pilotPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => Schema.decodeUnknownSync(Trace)(JSON.parse(line)))
    const rows = [...new Map(traces.map((trace) => [trace.attempt, trace])).values()]
    const writer = rows.find((trace) => trace.attempt === 1)
    expect(writer).toMatchObject({
      model: 'qwen3.8-flash',
      output: 4198,
      reasoningTokens: 4101,
      reservedOutput: 2448,
      phase: 'preflight',
    })
    if (writer === undefined) throw new Error('Missing actual Qwen preflight receipt')
    expect(exceededReservation(writer)).toBe(true)
    expect(rows.filter(exceededReservation).map((trace) => trace.attempt)).toEqual([1, 5])
  },
)

const pairedPath = resolve(dir, '../../runs/optchat-search-pilot-03-qwen-no-thinking-live')
test.skipIf(!existsSync(resolve(pairedPath, 'resolved.json')))(
  'actual partial paired run retains the 71-attempt loop and all six unstarted answers',
  () => {
    const resolved = Schema.decodeUnknownSync(Resolved)(
      JSON.parse(readFileSync(resolve(pairedPath, 'resolved.json'), 'utf8')),
    )
    const traces = readFileSync(resolve(pairedPath, 'attempts.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => Schema.decodeUnknownSync(Trace)(JSON.parse(line)))
    const reviews = readFileSync(resolve(pairedPath, 'reviews.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => Schema.decodeUnknownSync(Review)(JSON.parse(line)))
    const results = readdirSync(resolve(pairedPath, 'episodes'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const result = Schema.decodeUnknownSync(EpisodeResult)(
          JSON.parse(readFileSync(resolve(pairedPath, 'episodes', name), 'utf8')),
        )
        const review = reviews.findLast((item) => item.episodeId === result.id)
        return review === undefined ? result : applyReview(resolved, result, review)
      })
    const data = { resolved, traces, results }
    expect(
      stageGate(
        {
          ...data,
          resolved: {
            ...resolved,
            manifest: { ...resolved.manifest, allowance: { ...resolved.manifest.allowance, maxRequestsPerAnswer: 6 } },
          },
        },
        22,
      ).reasons,
    ).toContain('Per-answer request ceiling exceeded')
    const failedAnswer = results.find((result) =>
      result.id.endsWith('.22.abstention.optchat.qwen3.8-flash.qwen3.8-flash'),
    )
    if (failedAnswer === undefined) throw new Error('Missing frozen abstention answer')
    expect(answerMetrics(data, failedAnswer.id)).toMatchObject({
      outcome: 'fail',
      apiAttempts: 71,
      apiRetries: 0,
      toolCalls: 70,
      deniedToolCalls: 66,
      chargedInputTokens: 692265,
      chargedOutputTokens: 2925,
      apiLatencyMs: 101226,
      apiLatencyCoverage: 71,
      answerMs: null,
      episodeMs: null,
    })
    const arms = Object.values(efficiency(data))
    expect(arms.map((arm) => arm.unstartedAnswers)).toEqual([3, 3])
    expect(arms.map((arm) => arm.completedAnswers)).toEqual([3, 3])
    expect(arms.map((arm) => arm.correctAnswers)).toEqual([0, 0])
    expect(arms.map((arm) => arm.chargedInputTokens)).toEqual([713490, 69359])
    expect(arms.map((arm) => arm.apiAttempts)).toEqual([74, 9])
    expect(arms.map((arm) => arm.toolCalls.total)).toEqual([71, 6])
    expect(arms.map((arm) => arm.spend)).toEqual([null, null])
  },
)
