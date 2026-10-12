import type { Me } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { networkState, showsOtherNetworks } from './networks.ts'

const owner = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'
const NOW = Date.parse('2026-10-12T08:00:00Z')
const allowance = (expiresAt: string) => ({ perHour: '20', expiresAt, delegationHash: '0xab' })
const me = (chains: Me['chains']): Me => ({ userId: 'u', owner, agent: owner, chains })

describe('networkState', () => {
  it('walks not upgraded, upgraded, active from server state', () => {
    expect(networkState(me([]), 'arbitrum', NOW)).toEqual({ kind: 'not_upgraded' })
    expect(networkState(me([{ chain: 'arbitrum', upgraded: true }]), 'arbitrum', NOW)).toEqual({ kind: 'upgraded' })
    const active = me([{ chain: 'arbitrum', upgraded: true, allowance: allowance('2026-10-19T08:00:00Z') }])
    expect(networkState(active, 'arbitrum', NOW)).toEqual({
      kind: 'active',
      perHour: '20',
      expiresAt: '2026-10-19T08:00:00Z',
    })
  })

  it('reads each chain on its own', () => {
    const chains = me([{ chain: 'arbitrum', upgraded: true }])
    expect(networkState(chains, 'ethereum', NOW)).toEqual({ kind: 'not_upgraded' })
  })

  it('asks for the upgrade before anything recorded on an account that is not upgraded', () => {
    const odd = me([{ chain: 'ethereum', upgraded: false, allowance: allowance('2026-10-19T08:00:00Z') }])
    expect(networkState(odd, 'ethereum', NOW)).toEqual({ kind: 'not_upgraded' })
  })

  it('marks an allowance past its expiry as expired', () => {
    const ended = me([{ chain: 'ethereum', upgraded: true, allowance: allowance('2026-10-12T07:59:59Z') }])
    expect(networkState(ended, 'ethereum', NOW).kind).toBe('expired')
  })
})

describe('showsOtherNetworks', () => {
  it('waits until Base is upgraded and has an allowance', () => {
    expect(showsOtherNetworks(me([]))).toBe(false)
    expect(showsOtherNetworks(me([{ chain: 'base', upgraded: true }]))).toBe(false)
    expect(showsOtherNetworks(me([{ chain: 'arbitrum', upgraded: true, allowance: allowance('2026-10-19') }]))).toBe(
      false,
    )
    expect(showsOtherNetworks(me([{ chain: 'base', upgraded: true, allowance: allowance('2026-10-19') }]))).toBe(true)
  })
})
