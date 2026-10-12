import { describe, expect, test } from 'vitest'
import { testStore } from './fixtures.ts'

describe('allowances', () => {
  test('a prepared draft is found by its hash, in any case', () => {
    const { store } = testStore()
    store.putPreparedAllowance('0xAbC1', '{"draft":1}')
    expect(store.preparedAllowance('0xabc1')).toBe('{"draft":1}')
    expect(store.preparedAllowance('0xdead')).toBeUndefined()
  })

  test("a chain's signed allowance replaces the earlier one, and each chain keeps its own", () => {
    const { store } = testStore()
    store.putSignedAllowance('base', '{"v":1}')
    store.putSignedAllowance('base', '{"v":2}')
    store.putSignedAllowance('arbitrum', '{"v":3}')
    expect(store.signedAllowances()).toEqual([
      { chain: 'arbitrum', json: '{"v":3}' },
      { chain: 'base', json: '{"v":2}' },
    ])
  })

  test('the view state never sees an allowance', () => {
    const { store } = testStore()
    store.putSignedAllowance('base', '{"v":1}')
    expect(store.viewState()).not.toContain('"v":1')
  })
})
