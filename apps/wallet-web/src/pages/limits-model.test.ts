import type { LimitView } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { LIMITS } from '../api/fixtures.ts'
import { shareUsed } from '../ui/limit-meter.tsx'
import { metersOf } from './limits-model.ts'

describe('metersOf', () => {
  it("shows the wallet's own per-payment, hourly and weekly limits", () => {
    const meters = metersOf(LIMITS)
    expect(meters.map((meter) => [meter.period, meter.limit.layer, meter.limit.limit, meter.left])).toEqual([
      ['call', 'ledger', '5', undefined],
      ['hour', 'ledger', '20', '12.57'],
      ['week', 'ledger', '50', '31.1'],
    ])
    expect(meters[1]?.used).toBe(37.1)
  })

  it('falls back to the tightest limit that applies everywhere, never one network alone', () => {
    const signer: LimitView = { layer: 'signer', period: 'call', limit: '3', enforcedBy: 'signer' }
    const client: LimitView = { layer: 'client', period: 'call', limit: '2', enforcedBy: 'client' }
    const tempo: LimitView = { ...client, layer: 'tempo', limit: '1', chain: 'tempo' }
    expect(metersOf([signer, client, tempo]).map((meter) => meter.limit.limit)).toEqual(['2'])
  })

  it('has no meter for a period nothing limits', () => {
    expect(metersOf([])).toEqual([])
  })
})

describe('shareUsed', () => {
  it('keeps a tiny use visible and caps at 100', () => {
    const limit: LimitView = { layer: 'ledger', period: 'hour', limit: '20', used: '0.02', enforcedBy: 'wallet' }
    expect(shareUsed(limit)).toBe(0.1)
    expect(shareUsed({ ...limit, used: '25' })).toBe(100)
    expect(shareUsed({ ...limit, used: undefined })).toBe(0)
  })
})
