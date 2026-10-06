import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test } from 'vitest'
import { Schema } from 'effect'
import { archiveRead, archiveSearch } from '../worker/archive.ts'
import { byteLength, contextSources, delivery, sourceSlice } from '../worker/sources.ts'
import { Retrieval } from '../worker/retrieval.ts'
import { replayEntry } from '../worker/replay.ts'
import { evaluated, validDelivery } from '../src/evaluate.ts'
import { starterManifest } from '../src/manifest.ts'
import { Corpus } from '../src/corpus.ts'
import type { ReplayEvent } from '../src/protocol.ts'
import type { EntryRecord } from '@earendil-works/pi-durable'

const events: ReplayEvent[] = [
  {
    id: 'read-call',
    kind: 'tool-call',
    callId: 'read-1',
    toolName: 'Read',
    arguments: { file_path: '/repo/styles.css' },
    text: 'Read styles.css',
  },
  {
    id: 'read-result',
    kind: 'tool-result',
    callId: 'read-1',
    toolName: 'Read',
    text: '猫😺\n.shell { max-width: 880px; }\n'.repeat(500),
    isError: false,
  },
]

test('large real-style tool results yield bounded excerpts, paired-call metadata, and exact continuation', async () => {
  const found = archiveSearch(events, 'styles.css')
  expect(byteLength(found.text)).toBeLessThanOrEqual(2048)
  expect(found.deliveries.some((item) => item.id === 'read-result')).toBe(true)
  expect(found.text).toContain('/repo/styles.css')
  const first = archiveRead(events, 'read-result')
  const second = archiveRead(events, 'read-result', first.deliveries[0]?.endBytes, 1000)
  expect(byteLength(first.text)).toBeLessThanOrEqual(2048)
  expect(byteLength(second.text)).toBeLessThanOrEqual(1000)
  expect(second.deliveries[0]?.offsetBytes).toBe(first.deliveries[0]?.endBytes)
  for (const item of [...found.deliveries, ...first.deliveries, ...second.deliveries])
    expect(validDelivery(item, events)).toBe(true)
  expect(sourceSlice('a猫😺b', 2, 5)).toMatchObject({ start: 4, end: 9, text: '😺b' })
  const budget = new Retrieval(4, 4096)
  expect(await budget.get('archive_search', async () => found)).toBe(found.text)
  expect(await budget.get('archive_read', async () => first)).toBe(first.text)
  expect(await budget.get('archive_read', async () => archiveRead(events, 'future'))).toBe('Source unavailable.')
  expect(
    await budget.get('zoom', async () => ({ text: 'x'.repeat(4096), deliveries: [delivery(events[0]!, 'zoom')] })),
  ).toContain('byte limit')
  expect(await budget.get('archive_read', async () => first)).toContain('call limit')
  expect(budget.deliveries).toEqual([...found.deliveries, ...first.deliveries])
  expect(archiveRead(events, 'future')).toEqual(archiveRead(events, 'missing'))
})

test('native entry provenance distinguishes originals from source IDs copied into a summary or answer', () => {
  const event: ReplayEvent = { id: 'owner', kind: 'user', text: 'Approve the sidebar change.' }
  const message = replayEntry(event).model![0]!
  // SAFETY: these fixed native entry IDs identify only this injected context fixture.
  const id = 1 as EntryRecord['id']
  // SAFETY: this fixed conversation ID belongs only to this injected context fixture.
  const conversationId = 1 as EntryRecord['conversationId']
  const make = (kind: string, data: NonNullable<EntryRecord['data']>): EntryRecord => ({
    id,
    conversationId,
    kind,
    data,
    model: [message],
  })
  const context = (entry: EntryRecord) => ({
    head: undefined,
    entries: [entry],
    contributions: [[message]],
    messages: [message],
  })
  expect(contextSources(context(make('app.memory', {})), [event])).toEqual([])
  expect(contextSources(context(make('pi.assistant', {})), [event])).toEqual([])
  expect(contextSources(context(make('pi.user', { benchSourceIds: ['owner'] })), [event])[0]?.deliveries).toEqual([
    delivery(event, 'context'),
  ])
  const probe = {
    id: 'probe',
    scenarioId: 'scenario',
    cutoff: 1,
    category: 'latest-state' as const,
    question: '',
    keys: [],
  }
  const resolved = {
    manifest: starterManifest(),
    sourceHash: '',
    corpusHash: '',
    runId: '',
    mode: 'live' as const,
    createdAt: '',
    scenarios: [
      { id: 'scenario', family: 'scenario', split: 'development' as const, events: [event], probes: [probe] },
    ],
  }
  const variant = { id: 'baseline', policy: 'optchat' as const, writer: 'qwen3.8-flash', reader: 'grok-4.7' }
  const answer = JSON.stringify({ claims: [], evidenceIds: ['owner'], abstain: false })
  const result = evaluated(
    resolved,
    { id: 'probe.baseline', variant, probe },
    {
      status: 'done',
      text: answer,
      context: [{ role: 'user', text: `[source:owner]` }],
      retrieval: [],
      deliveries: [],
    },
  )
  expect(result.deliveredIds).toEqual([])
  expect(result.score.evidenceValid).toBe(false)
  expect(validDelivery({ ...delivery(event, 'read'), text: 'invented' }, [event])).toBe(false)
})

const path = resolve(import.meta.dirname, '../../.local/bench/corpora/claude-canary/labeled.json')
test.skipIf(!existsSync(path))('frozen original Read results remain searchable without whole-event denial', () => {
  const corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(readFileSync(path, 'utf8')))
  const prefix = corpus.scenarios[0]!.events.slice(0, 32)
  const found = archiveSearch(prefix, 'styles.css')
  expect(byteLength(found.text)).toBeLessThanOrEqual(2048)
  expect(found.deliveries.map((item) => item.id)).toContain('claude.l99.b0')
  expect(found.text).toContain('styles.css')
  const read = archiveRead(prefix, 'claude.l99.b0')
  expect(byteLength(read.text)).toBeLessThanOrEqual(2048)
  expect(read.text).toContain('880px')
  expect(read.deliveries.every((item) => validDelivery(item, prefix))).toBe(true)
  expect(archiveRead(prefix.slice(0, 22), 'claude.l99.b0').unavailable).toBe(true)
})

test.skipIf(!existsSync(path))(
  'actual CSS search failure now delivers values and leaves room for a continuation read',
  async () => {
    const corpus = Schema.decodeUnknownSync(Corpus)(JSON.parse(readFileSync(path, 'utf8')))
    const prefix = corpus.scenarios[0]!.events.slice(0, 32)
    const budget = new Retrieval(4, 8192, true)
    for (const query of ['.shell max-width padding styles.css', 'shell safe-area-inset-left padding inline']) {
      const response = await budget.get('archive_search', async (allowance) => archiveSearch(prefix, query, allowance))
      expect(response).toContain('remainingBytes')
      expect(budget.trace.at(-1)?.denied).toBe(false)
    }
    const read = await budget.get('archive_read', async (allowance) =>
      archiveRead(prefix, 'claude.l99.b0', 0, Math.min(600, allowance.maxBytes), true),
    )
    expect(read).toContain('880px')
    expect(budget.trace.every((item) => !item.denied)).toBe(true)
    expect(budget.trace.reduce((n, item) => n + byteLength(item.text), 0)).toBeLessThanOrEqual(8192)
    expect(budget.deliveries.every((item) => validDelivery(item, prefix))).toBe(true)
    expect(
      archiveSearch(prefix, 'styles.css', { maxBytes: 2048, compact: true }).deliveries.length,
    ).toBeLessThanOrEqual(2)
  },
)
