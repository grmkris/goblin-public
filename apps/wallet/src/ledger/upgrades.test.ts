import { describe, expect, test } from 'vitest'
import { testStore } from './fixtures.ts'

describe('prepared upgrades', () => {
  test('a prepared upgrade is found by its id, and a later one with the same id replaces it', () => {
    const { store } = testStore()
    store.putPreparedUpgrade('upgrade:base:1', '{"draft":1}')
    expect(store.preparedUpgrade('upgrade:base:1')).toBe('{"draft":1}')
    store.putPreparedUpgrade('upgrade:base:1', '{"draft":2}')
    expect(store.preparedUpgrade('upgrade:base:1')).toBe('{"draft":2}')
    expect(store.preparedUpgrade('upgrade:base:2')).toBeUndefined()
  })

  test('the view state never sees a prepared upgrade', () => {
    const { store } = testStore()
    store.putPreparedUpgrade('upgrade:base:1', '{"draft":1}')
    expect(store.viewState()).not.toContain('"draft":1')
  })
})
