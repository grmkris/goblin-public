import { describe, expect, it } from 'vitest'
import { cancelledReason } from '../src/lib/call-outcome.ts'

describe('whether a call behind an App completed', () => {
  it.each(['approval-required', 'url-required', 'grant-required', 'connect-required', 'scope-required'])(
    'reads %s as a call that did not complete, with a reason',
    (kind) => {
      expect(cancelledReason({ kind, connectionId: 'c', name: 't' })).toEqual(expect.any(String))
    },
  )
  it('reads a result as completed, and a marker it does not know as one too', () => {
    expect(cancelledReason({ structuredContent: { a: 1 } })).toBeUndefined()
    expect(cancelledReason({ kind: 'toString' })).toBeUndefined()
    expect(cancelledReason({ kind: 'something-else' })).toBeUndefined()
    expect(cancelledReason(undefined)).toBeUndefined()
    expect(cancelledReason('approval-required')).toBeUndefined()
  })
})
