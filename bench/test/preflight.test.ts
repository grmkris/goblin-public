import { expect, test } from 'vitest'
import { validatePreflight } from '../scripts/preflight.ts'
import type { Trace } from '../src/results.ts'

const source = { id: 'owner.request', kind: 'user' as const, text: 'Put threads in the sidebar.' }
const options = {
  native: {
    status: 'done' as const,
    text: '',
    retrieval: [{ operation: 'archive_search' as const, text: source.text, denied: false }],
    deliveries: [
      {
        ...source,
        origin: 'search' as const,
        offsetBytes: 0,
        endBytes: source.text.length,
        totalBytes: source.text.length,
      },
    ],
    context: [],
  },
  answer: {
    claims: [{ key: 'owner-request', value: source.text }],
    evidenceIds: [source.id],
    abstain: false,
  },
  actor: 'shared-writer',
  operation: 'preflight-reader',
  events: [source],
  sourceId: source.id,
  writerId: 'grok-4.7',
  readerId: 'grok-4.7',
  readerMaxOutputTokens: 4096,
}
const traces: Trace[] = ['shared-writer', 'preflight-reader', 'preflight-reader'].map((scope, index) => ({
  scope,
  model: 'grok-4.7',
  phase: 'preflight',
  attempt: index + 1,
  status: 200,
  input: 10,
  output: 10,
  reservedInput: 100,
  reservedOutput: scope === 'shared-writer' ? 2448 : 4096,
  unknownUsage: false,
  request: JSON.stringify({ model: 'grok-4.7', max_tokens: scope === 'shared-writer' ? 2448 : 4096 }),
  response: '',
  at: '2026-10-05T00:00:00Z',
}))

test('same-model preflight distinguishes writer and reader output limits by operation scope', () => {
  expect(validatePreflight({ ...options, traces })).toMatchObject({ passed: true, checks: { capped: true } })
  const wrongReaderLimit = traces.map((trace) => ({
    ...trace,
    request: JSON.stringify({ model: trace.model, max_tokens: 2448 }),
  }))
  expect(validatePreflight({ ...options, traces: wrongReaderLimit })).toMatchObject({
    passed: false,
    checks: { capped: false },
  })
})

test('same-model preflight still rejects reported usage beyond the reservation', () => {
  const overrun = traces.map((trace) => ({ ...trace, output: 5000 }))
  expect(validatePreflight({ ...options, traces: overrun })).toMatchObject({
    passed: false,
    checks: { capped: true, usageBounded: false },
  })
})
