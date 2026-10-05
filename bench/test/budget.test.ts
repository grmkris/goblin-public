import { expect, test } from 'vitest'
import { providerDetails } from '../src/provider-details.ts'
import { Budget, usageOf } from '../src/budget.ts'
import { starterManifest } from '../src/manifest.ts'
import { Retrieval } from '../worker/retrieval.ts'

test('unknown usage and transient retries cannot reset the shared allowance', () => {
  const limits = { ...starterManifest().allowance, maxRequests: 2, maxInputTokens: 100, maxOutputTokens: 20 }
  const budget = new Budget(limits)
  expect(budget.reserve({ input: 40, output: 10 })).toBe(true)
  budget.reconcile({ input: 40, output: 10 }, undefined)
  expect(budget.reserve({ input: 40, output: 10 })).toBe(true)
  expect(budget.reserve({ input: 1, output: 1 })).toBe(false)
  expect(new Budget(limits, budget.totals()).reserve({ input: 1, output: 1 })).toBe(false)
})
test('SSE accounting includes completion tokens and missing usage stays unknown', () => {
  expect(
    usageOf('data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":33,"completion_tokens":17}}\n\ndata: [DONE]\n'),
  ).toEqual({ input: 33, output: 17 })
  expect(usageOf('data: {"choices":[]}\n\ndata: [DONE]\n')).toBeUndefined()
})
test('zoom/search share UTF-8 byte and call ceilings, including rejected retrievals', async () => {
  const retrieval = new Retrieval(2, 4)
  expect(await retrieval.get('zoom', async () => ({ text: '猫', deliveries: [] }))).toBe('猫')
  expect(await retrieval.get('archive_search', async () => ({ text: '猫', deliveries: [] }))).toContain('byte limit')
  expect(await retrieval.get('archive_read', async () => ({ text: 'a', deliveries: [] }))).toContain('call limit')
  expect(retrieval.trace).toEqual([
    { operation: 'zoom', text: '猫', denied: false },
    { operation: 'archive_search', text: '', denied: true },
    { operation: 'archive_read', text: '', denied: true },
  ])
})

test('provider metadata counts reasoning once and rejects malformed usage', () => {
  const reply = JSON.stringify({
    model: 'glm-5.3',
    id: 'observed-response',
    usage: {
      prompt_tokens: 1122,
      completion_tokens: 2448,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 2446 },
    },
  })
  expect(usageOf(reply)).toEqual({ input: 1122, output: 2448 })
  expect(providerDetails(reply)).toMatchObject({
    responseModel: 'glm-5.3',
    responseId: 'observed-response',
    reasoningTokens: 2446,
    cacheReadTokens: 0,
  })
  expect(usageOf('{"usage":{"prompt_tokens":-1,"completion_tokens":3}}')).toBeUndefined()
})
