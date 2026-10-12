import type { LimitView } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { STATUS } from '../api/fixtures.ts'
import { assetOn, blockerText, constraintText, limitValue } from './overview-copy.ts'
import { spendingOf } from './overview-model.ts'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const hour: LimitView = {
  layer: 'ledger',
  period: 'hour',
  limit: '20',
  used: '15.5',
  remaining: '4.5',
  enforcedBy: 'This wallet',
  periodEndsAt: '2026-10-12T12:41:00Z',
}
const spending = spendingOf(STATUS, { now: NOW })

describe('overview sentences', () => {
  it('names the asset and the network', () => {
    expect(assetOn(spending)).toBe('USDC on Base')
  })

  it('says which limit holds the amount back and when it resets', () => {
    expect(constraintText({ kind: 'limit', limit: hour }, NOW)).toBe(
      'Held back by your hourly limit: $4.50 left, until it resets in 41 min.',
    )
    expect(constraintText({ kind: 'limit', limit: { ...hour, layer: 'client', period: 'day' } }, NOW)).toContain(
      "your MCP client's daily limit",
    )
  })

  it('says unknown, never zero, when the network could not be read', () => {
    expect(blockerText({ kind: 'unread' }, spending, NOW)).toBe(
      'Balances on Base could not be read, so this is unknown, not zero.',
    )
  })

  it('explains owner funds without an allowance, keeping a micro-amount exact', () => {
    expect(blockerText({ kind: 'no_allowance', owner: 62_500_000n }, spending, NOW)).toBe(
      'Your account holds $62.50 USDC on Base, but your agent has no allowance to draw on it.',
    )
    expect(blockerText({ kind: 'no_allowance', owner: 7_000n }, spending, NOW)).toContain('$0.007')
  })

  it('shows a per-payment cap as a cap and a period as what is left', () => {
    expect(limitValue({ ...hour, period: 'call', limit: '0.05' })).toBe('up to $0.05')
    expect(limitValue(hour)).toBe('$4.50 left of $20.00')
    expect(limitValue({ ...hour, limit: '50', remaining: '37.348708' })).toBe('$37.34 left of $50.00')
  })
})
