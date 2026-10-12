import { describe, expect, it } from 'vitest'
import { MAX_APP_CONTEXT } from '@goblin/contracts'
import { sharedOf } from '../src/components/apps/offers.tsx'

/** An App instance as the host keeps it: where it is docked, and what it offers to share, if anything. */
const app = (id: string, conversation: string, context?: string) => ({
  app: { id, conversation },
  ...(context === undefined ? {} : { context }),
})

describe('what the next message shares from the Apps (the send limit)', () => {
  it('carries only the newest Apps up to the limit, so four receipts never make Send do nothing', () => {
    const instances = [
      app('a', '1', 'paid 1'),
      app('b', '1', 'paid 2'),
      app('other', '2', 'elsewhere'),
      app('c', '1'),
      app('d', '1', 'paid 3'),
      app('e', '1', 'paid 4'),
    ]
    const { offering, shared } = sharedOf(instances, '1')
    expect(offering.map((each) => each.app.id)).toEqual(['a', 'b', 'd', 'e'])
    expect(shared.map((each) => each.app.id)).toEqual(['d', 'e'])
    expect(shared).toHaveLength(MAX_APP_CONTEXT)
  })
})
