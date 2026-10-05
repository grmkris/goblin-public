import { Effect, FileSystem, Layer, Crypto, Schema } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { expect, test } from 'vitest'
import { BlindPacket, validateVote } from '../src/blind.ts'
import { resolution, semanticOutcome, type SemanticVote } from '../src/semantic.ts'
import { EpisodeResult, Resolved } from '../src/results.ts'
import { failedScore } from '../src/evaluate.ts'
import { starterManifest } from '../src/manifest.ts'
import { exportPacket, importVotes, readPacket } from '../scripts/blind.ts'

const score = {
  factualCorrect: true,
  evidenceComplete: true,
  evidenceValid: true,
  abstentionCorrect: true,
  unsupported: false,
}
const vote: SemanticVote = {
  voteId: 'machine-vote',
  packetId: 'packet',
  caseId: 'case',
  kind: 'machine',
  reviewer: 'machine-reviewer',
  rationale: 'Supported by the owner request',
  evidenceIds: ['owner'],
  searchSupported: true,
  score,
  resolves: [],
  at: '2026-10-05T12:00:00Z',
  runId: 'review-run',
  sourceHash: 'source',
  corpusHash: 'corpus',
  episodeId: 'probe.base',
  resultHash: '',
  packetHash: '',
}
const result: EpisodeResult = {
  id: 'probe.base',
  variant: 'base',
  category: 'latest-state',
  status: 'completed',
  rawAnswer: 'The owner requested threads [owner].',
  answer: null,
  score: failedScore,
  malformed: true,
  futureLeakage: false,
  unauthorizedReads: false,
  forbiddenEndorsement: false,
  deliveredIds: ['owner'],
  deliveries: [
    { id: 'owner', kind: 'user', offsetBytes: 0, endBytes: 7, totalBytes: 7, text: 'Threads', origin: 'search' },
  ],
  detail: '',
}
const item = {
  caseId: 'case',
  question: 'What did the owner request?',
  category: 'latest-state' as const,
  prefix: [{ id: 'owner', kind: 'user' as const, text: 'Threads' }],
  delivered: result.deliveries ?? [],
  rawAnswer: result.rawAnswer ?? '',
}
test('malformed original can pass factual recall but never strict format; machine-only is diagnostic', () => {
  const human = { ...vote, voteId: 'human-vote', kind: 'human' as const, reviewer: 'human-reviewer' }
  expect(semanticOutcome(result, [vote]).semanticPass).toBeNull()
  expect(semanticOutcome(result, [vote, human])).toMatchObject({
    semanticPass: true,
    strictPass: false,
    evidencePass: true,
  })
  expect(result.score.correct).toBe(false)
  expect(semanticOutcome({ ...result, futureLeakage: true }, [vote, human]).semanticPass).toBe(false)
})
test('disagreement is preserved until human adjudication names both votes', () => {
  const human = {
    ...vote,
    voteId: 'human-vote',
    kind: 'human' as const,
    reviewer: 'human-reviewer',
    score: { ...score, factualCorrect: false },
  }
  expect(resolution([vote, human])).toMatchObject({ disagreed: true, final: undefined })
  const adjudication = {
    ...human,
    kind: 'adjudication' as const,
    voteId: 'adjudication',
    resolves: [vote.voteId, human.voteId],
  }
  expect(validateVote(item, adjudication, [vote, human])).toEqual([])
  expect(validateVote(item, { ...adjudication, resolves: [] }, [vote, human])).toContain(
    'Adjudication must name both disputed vote IDs',
  )
  expect(resolution([vote, human, adjudication]).final).toBe(adjudication)
})
test('prefix and actual cited source receipts constrain search support', () => {
  expect(validateVote(item, { ...vote, evidenceIds: ['future'] }, [])).toContain('Vote evidence exceeds prefix')
  expect(validateVote({ ...item, delivered: [] }, vote, [])).toContain(
    'Search support requires original cited search/read delivery',
  )
  expect(validateVote({ ...item, rawAnswer: 'No cited source.' }, vote, [])).toContain(
    'Search support requires original cited search/read delivery',
  )
})

test('packet reuse, sealed import, idempotency and answer tampering with injected filesystem', async () => {
  const resolved = Schema.decodeUnknownSync(Resolved)({
    manifest: {
      ...starterManifest(),
      scenarioIds: ['session'],
      variants: [{ id: 'base', policy: 'standard', reader: 'deepseek-v4-pro-0813' }],
      corpus: { path: 'private', sha256: 'corpus' },
    },
    sourceHash: 'source',
    corpusHash: 'corpus',
    runId: 'review-run',
    createdAt: '',
    mode: 'live',
    scenarios: [
      {
        id: 'session',
        family: 'real',
        split: 'development',
        events: item.prefix,
        probes: [
          {
            id: 'probe',
            scenarioId: 'session',
            cutoff: 1,
            category: 'latest-state',
            question: item.question,
            keys: ['request'],
            label: {
              requiredClaims: [{ key: 'request', meaning: 'Threads' }],
              evidenceIds: ['owner'],
              mustAbstain: false,
              prohibitedClaims: [],
              rubric: 'Owner requested threads',
            },
          },
        ],
      },
    ],
  })
  const files = new Map([
    ['run/resolved.json', JSON.stringify(resolved)],
    ['run/episodes/probe.base.json', JSON.stringify(result)],
  ])
  const fs = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    makeDirectory: () => Effect.void,
    remove: () => Effect.void,
    readDirectory: () => Effect.succeed(['probe.base.json']),
    readFileString: (path) => Effect.succeed(files.get(path) ?? ''),
    writeFileString: (path, content, options) =>
      Effect.sync(() => {
        files.set(path, `${options?.flag === 'a' ? (files.get(path) ?? '') : ''}${content}`)
      }),
  })
  const crypto = Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => new Uint8Array(size).fill(7),
      digest: () => Effect.succeed(new Uint8Array()),
    }),
  )
  const services = Layer.mergeAll(fs, crypto, FetchHttpClient.layer)
  const execute = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Crypto.Crypto | import('effect/http/HttpClient').HttpClient | import('effect/Scope').Scope
    >,
  ) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(services)))
  await execute(exportPacket('run', 'stage-22', 22))
  const sealed = await execute(readPacket('run', 'stage-22'))
  const encoded = JSON.stringify(sealed.packet)
  expect(encoded).not.toContain('deepseek')
  expect(encoded).not.toContain('resultHash')
  expect(encoded).not.toContain('probe.base')
  expect(encoded).not.toContain('latency')
  expect(Schema.decodeUnknownSync(BlindPacket)(sealed.packet).cases[0]?.rawAnswer).toBe(result.rawAnswer)
  expect(await execute(exportPacket('run', 'stage-22', 22))).toMatchObject({ reused: true })
  const first = sealed.packet.cases[0]
  if (first === undefined) throw new Error('Missing blinded case')
  files.set('votes', JSON.stringify([{ ...vote, packetId: sealed.packet.packetId, caseId: first.caseId }]))
  expect(await execute(importVotes('run', 'stage-22', 'votes'))).toMatchObject({
    imported: 1,
    originalScoresChanged: false,
  })
  expect(await execute(importVotes('run', 'stage-22', 'votes'))).toMatchObject({ imported: 0, skipped: 1 })
  files.set('run/episodes/probe.base.json', JSON.stringify({ ...result, rawAnswer: 'Changed answer' }))
  await expect(execute(importVotes('run', 'stage-22', 'votes'))).rejects.toThrow(
    'Semantic review identity or answer changed',
  )
})
