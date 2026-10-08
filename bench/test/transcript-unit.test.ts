import { boundedExcerpt, redactedExcerpt } from '../src/retrieval-excerpt.ts'
import { describe, expect, test } from 'vitest'
import { fixtureCorpus, corpusHash, fixtureSha256 } from './transcript-fixture.ts'
import { ftsQuery, queryMetrics, sourceFor } from '../src/retrieval-metrics.ts'
import { runVectorArm, type VectorizeApi, type EmbeddingApi } from '../src/retrieval-vector.ts'
import { rerankTop20 } from '../src/rerank.ts'

describe('cross-chat retrieval fixtures and evidence', () => {
  test('captured evidence redacts nested credential fields while retaining public token data', () => {
    const original = JSON.stringify({
      password: 'redactionprobe',
      nested: { authorization: 'redactionprobe' },
      token: 'public-value',
      rewardToken: 'asset-value',
    })
    const redacted = redactedExcerpt(original)
    expect(redacted).not.toContain('redactionprobe')
    expect(redacted).toContain('public-value')
    expect(redacted).toContain('asset-value')
    expect(redactedExcerpt('Bearer redactionprobe access_token=redactionprobe')).not.toContain('redactionprobe')
    const snapshot = sourceFor({ ...fixtureCorpus().messages[0]!, text: original }, 0.1, 'rev', 123)
    expect(snapshot.excerpt).not.toContain('redactionprobe')
  })

  test('frozen ranges reference their own chat; absent labels contain no targets', () => {
    expect(fixtureSha256).toBe('6c750e41b0aa29ce6fb1c65c191686bad6d1ddc9fc273d07f491b0ea76e7fcd3')
    const { messages, labels } = fixtureCorpus()
    expect(messages).toHaveLength(3000)
    expect(labels).toHaveLength(80)
    expect(new Set(messages.map((item) => item.chatId)).size).toBe(120)
    expect(new Set(labels.map((item) => item.query)).size).toBe(80)
    const byId = new Map(messages.map((item) => [item.entryId, item]))
    for (const label of labels)
      for (const target of label.targets) {
        for (let id = target.start; id <= target.end; id += 1) expect(byId.get(id)?.chatId).toBe(target.chatId)
      }
    expect(labels.filter((label) => label.kind === 'none').every((label) => label.targets.length === 0)).toBe(true)
    expect(corpusHash(messages, labels)).toBe('bb06d686eec4e17405a339d19cc85bff7cf9e4c4161bf0a228ca33b956214295')
  })
  test('range recall and absence do not inflate recall or MRR', () => {
    const label = {
      id: 'q',
      query: 'q',
      kind: 'exact' as const,
      targets: [
        { chatId: 'a', start: 1, end: 2 },
        { chatId: 'b', start: 5, end: 5 },
      ],
    }
    expect(
      queryMetrics(label, [
        { entryId: 9, score: 0 },
        { entryId: 1, score: 0 },
        { entryId: 2, score: 0 },
      ]),
    ).toMatchObject({ recallAt5: 0.5, mrr: 0.5, precision: 2 / 3 })
    expect(queryMetrics({ ...label, targets: [] }, [])).toMatchObject({ recallAt5: null, mrr: null, noneCorrect: true })
    expect(queryMetrics({ ...label, targets: [] }, [{ entryId: 1, score: 0 }]).noneCorrect).toBe(false)
  })
  test('literal unicode FTS input and captured head/tail survive source changes', () => {
    expect(ftsQuery('" OR Tokyo* --')).toBe('"OR" OR "Tokyo"')
    expect(ftsQuery('駅 日本')).toBe('"駅" OR "日本"')
    expect(ftsQuery('***')).toBe('')
    const text = 'a'.repeat(12000) + 'last'
    expect(boundedExcerpt(text)).toContain('4 characters cut')
    expect(boundedExcerpt(text).endsWith('last')).toBe(true)
    const message = fixtureCorpus().messages[0]!
    const receipt = sourceFor(message, 0.9, 'sha256:revision', 123)
    expect(receipt).toMatchObject({
      chatId: message.chatId,
      sessionId: message.sessionId,
      entryStart: message.entryId,
      entryEnd: message.entryId,
      retrievedAt: 123,
      indexRevision: 'sha256:revision',
      score: 0.9,
    })
  })
})

test('injected vector provider keeps namespace and deletes index on failed query', async () => {
  const seen: string[] = []
  const api: VectorizeApi = {
    createIndex: async (name, dim) => {
      seen.push(`create:${name}:${dim}`)
    },
    upsert: async (namespace) => {
      seen.push(`upsert:${namespace}`)
    },
    query: async (namespace) => {
      seen.push(`query:${namespace}`)
      throw new Error('query failed')
    },
    deleteIndex: async (name) => {
      seen.push(`delete:${name}`)
    },
  }
  const embeddings: EmbeddingApi = { embed: async (texts) => texts.map(() => [1, 0]) }
  await expect(
    runVectorArm(api, embeddings, [{ id: 'one', text: 'passage' }], ['question'], {
      model: 'injected',
      namespace: 'owner-1',
    }),
  ).rejects.toThrow('query failed')
  expect(seen).toEqual([
    'create:goblin-spike-retrieval:2',
    'upsert:owner-1',
    'query:owner-1',
    'delete:goblin-spike-retrieval',
  ])
})
test('constrained rerank rejects invented ids and contradictory abstention', async () => {
  const candidates = [{ id: 'one', text: 'passage', score: 1 }]
  await expect(rerankTop20('q', candidates, async () => ({ ids: ['foreign'], none: false }))).rejects.toThrow(
    'Invalid rerank',
  )
  await expect(rerankTop20('q', candidates, async () => ({ ids: ['one'], none: true }))).rejects.toThrow(
    'Invalid rerank',
  )
  expect((await rerankTop20('q', candidates, async () => ({ ids: [], none: true }))).ids).toEqual([])
})
