import type { ChainBalance, WalletStatusResult } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { agentOnTempo, isEmpty, opensOnAddFunds } from './fund-model.ts'

const AGENT = '0x9aC3e1D5b7F20846c1A9d3E5f7B2048a6C1e9D3b'
const tempo = (balance: string): ChainBalance => ({
  chain: 'tempo',
  symbol: 'USDC.e',
  token: '0x20C000000000000000000000b9537d11c60E8b50',
  decimals: 6,
  balance,
  holder: 'agent',
  address: AGENT,
})

const status = (fields: Partial<WalletStatusResult>): WalletStatusResult => ({
  status: { kind: 'wallet', paid: 'blocked', funding: 'blocked', tokens: [] },
  owner: { address: AGENT, upgraded: false },
  agent: { address: AGENT },
  balances: [],
  limits: [],
  checkedAt: '2026-10-12T12:00:00Z',
  ...fields,
})

describe('the Pays from card', () => {
  it('reads the agent USDC.e on Tempo, and nothing when Tempo was not read', () => {
    expect(agentOnTempo(status({ payFrom: { address: AGENT, chain: 'tempo', token: 'USDC.e', held: '4.74' } }))).toBe(
      4_740_000n,
    )
    expect(agentOnTempo(status({ payFrom: { address: AGENT, chain: 'tempo', token: 'USDC.e' } }))).toBeUndefined()
  })

  it('an agent with nothing anywhere asks to fund this address; an unread chain might hold something', () => {
    const payFrom = { address: AGENT, chain: 'tempo' as const, token: 'USDC.e' as const, held: '0' }
    expect(isEmpty(status({ payFrom, balances: [tempo('0')] }))).toBe(true)
    expect(isEmpty(status({ payFrom, balances: [tempo('0.5')] }))).toBe(false)
    expect(isEmpty(status({ payFrom, balances: [], unread: ['tempo'] }))).toBe(false)
    expect(isEmpty(status({ balances: [] }))).toBe(false)
  })

  it('opens on Add funds when the host asked for it or the wallet is empty', () => {
    const payFrom = { address: AGENT, chain: 'tempo' as const, token: 'USDC.e' as const, held: '3' }
    expect(opensOnAddFunds(status({ payFrom, balances: [tempo('3')] }))).toBe(false)
    expect(opensOnAddFunds(status({ payFrom, balances: [tempo('3')], focus: 'add_funds' }))).toBe(true)
    expect(opensOnAddFunds(status({ payFrom: { ...payFrom, held: '0' }, balances: [] }))).toBe(true)
  })
})
