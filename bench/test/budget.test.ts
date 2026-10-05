import { expect, test } from 'vitest'
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
  expect(await retrieval.get(async () => '猫')).toBe('猫')
  expect(await retrieval.get(async () => '猫')).toContain('byte limit')
  expect(await retrieval.get(async () => 'a')).toContain('call limit')
  expect(retrieval.trace).toEqual([
    { text: '猫', denied: false },
    { text: '', denied: true },
    { text: '', denied: true },
  ])
})
