import type { ChainBalance, ChainKey, LimitView, Operation, WalletStatusResult } from '@goblin/wallet/contract'
import { describe, expect, it } from 'vitest'
import { OPERATIONS } from '../api/fixtures.ts'
import { attentionOf, balanceGroups, boundariesOf, spendingOf } from './overview-model.ts'

const OWNER = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'
const AGENT = '0x9aC3e1D5b7F20846c1A9d3E5f7B2048a6C1e9D3b'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const NATIVE = '0x0000000000000000000000000000000000000000'
const NOW = Date.parse('2026-10-12T12:00:00Z')
const LATER = '2026-10-19T12:00:00Z'

const usdc = (chain: ChainKey, holder: 'owner' | 'agent', balance: string): ChainBalance => ({
  chain,
  symbol: chain === 'tempo' ? 'USDC.e' : 'USDC',
  token: USDC,
  decimals: 6,
  balance,
  holder,
  address: holder === 'owner' ? OWNER : AGENT,
})
const eth = (chain: ChainKey, holder: 'owner' | 'agent', balance: string): ChainBalance => ({
  chain,
  symbol: 'ETH',
  token: NATIVE,
  decimals: 18,
  balance,
  holder,
  address: holder === 'owner' ? OWNER : AGENT,
})

/** A chain read the way the server reads it: USDC and ETH for both holders (Tempo has no ETH). */
function chainRead(chain: ChainKey, amounts: { agent?: string; owner?: string; agentEth?: string; ownerEth?: string }) {
  const rows = [usdc(chain, 'agent', amounts.agent ?? '0'), usdc(chain, 'owner', amounts.owner ?? '0')]
  if (chain === 'tempo') return rows
  return [...rows, eth(chain, 'agent', amounts.agentEth ?? '0'), eth(chain, 'owner', amounts.ownerEth ?? '0')]
}

const allowance = (chain: ChainKey, remaining: string, limit = '20'): LimitView => ({
  layer: 'onchain',
  period: 'hour',
  limit,
  remaining,
  used: '0',
  chain,
  enforcedBy: 'MetaMask ERC20PeriodTransfer enforcer',
})
const ledger = (period: 'call' | 'hour' | 'week', limit: string, remaining?: string): LimitView => ({
  layer: 'ledger',
  period,
  limit,
  ...(remaining === undefined ? {} : { remaining, used: '0' }),
  enforcedBy: 'This wallet',
})
const LEDGER = [ledger('call', '5'), ledger('hour', '20', '20'), ledger('week', '50', '50')]

function status(balances: readonly ChainBalance[], limits: readonly LimitView[] = LEDGER): WalletStatusResult {
  return {
    status: { kind: 'wallet', paid: 'ready', funding: 'ready', tokens: [], expiresAt: LATER },
    owner: { address: OWNER, upgraded: true },
    agent: { address: AGENT },
    balances,
    limits,
    checkedAt: '2026-10-12T12:00:00Z',
  }
}

const allRead = (base: Parameters<typeof chainRead>[1], others: Partial<Record<ChainKey, ChainBalance[]>> = {}) => [
  ...chainRead('base', base),
  ...(others.arbitrum ?? chainRead('arbitrum', {})),
  ...(others.ethereum ?? chainRead('ethereum', {})),
  ...(others.tempo ?? chainRead('tempo', {})),
]

const micros = (figure: { known: boolean; micros?: bigint }) => (figure.known ? figure.micros : 'unknown')

describe('what the agent can spend', () => {
  it('adds the agent wallet to what the allowance lets it draw from the owner, never ETH', () => {
    const spending = spendingOf(
      status(allRead({ agent: '1.21', owner: '62.5', agentEth: '0.0006', ownerEth: '0.0054' }), [
        ...LEDGER,
        allowance('base', '12.57'),
      ]),
      { now: NOW },
    )
    expect(spending.spend.chain).toBe('base')
    expect(micros(spending.available)).toBe(13_780_000n)
    expect(spending.constraint).toEqual({ kind: 'allowance', limit: allowance('base', '12.57') })
    expect(spending.blocker).toBeUndefined()
  })

  it('names the limit that holds it back', () => {
    const spending = spendingOf(status(allRead({ agent: '30' }), [ledger('hour', '20', '4.5')]), { now: NOW })
    expect(micros(spending.available)).toBe(4_500_000n)
    expect(spending.constraint).toEqual({ kind: 'limit', limit: ledger('hour', '20', '4.5') })
  })

  it('keeps a micro-amount exact', () => {
    const spending = spendingOf(status(allRead({ agent: '0.007' })), { now: NOW })
    expect(micros(spending.available)).toBe(7_000n)
    expect(spending.constraint).toEqual({ kind: 'funds' })
  })

  it('does not depend on the order the balances arrive in', () => {
    const rows = allRead({ agent: '2', owner: '9' })
    const limits = [allowance('base', '5'), ...LEDGER]
    const forward = spendingOf(status(rows, limits), { now: NOW })
    const backward = spendingOf(status(rows.toReversed(), limits.toReversed()), { now: NOW })
    expect(micros(backward.available)).toBe(micros(forward.available))
    expect(backward.spend.chain).toBe(forward.spend.chain)
  })

  it('takes the smallest per-payment cap that applies', () => {
    const signer: LimitView = { layer: 'signer', period: 'call', limit: '2.5', enforcedBy: 'Privy policy' }
    expect(spendingOf(status(allRead({ agent: '1' }), [...LEDGER, signer]), { now: NOW }).perPayment).toBe(signer)
  })
})

describe('why the agent cannot spend', () => {
  it('says the owner holds funds but gave no allowance', () => {
    const spending = spendingOf(status(allRead({ owner: '62.5' })), { now: NOW })
    expect(micros(spending.available)).toBe(0n)
    expect(spending.blocker).toEqual({ kind: 'no_allowance', owner: 62_500_000n })
  })

  it('says the allowance is used up for now', () => {
    const used = allowance('base', '0')
    const spending = spendingOf(status(allRead({ owner: '62.5' }), [...LEDGER, used]), { now: NOW })
    expect(spending.blocker).toEqual({ kind: 'allowance_used', owner: 62_500_000n, limit: used })
  })

  it('says only gas is there when the network holds ETH and no stablecoin', () => {
    const spending = spendingOf(status(allRead({ ownerEth: '0.01' })), { now: NOW })
    expect(spending.blocker).toEqual({ kind: 'gas_only' })
  })

  it('says a limit is reached when money is there', () => {
    const spent = ledger('hour', '20', '0')
    const spending = spendingOf(status(allRead({ agent: '3' }), [spent]), { now: NOW })
    expect(spending.blocker).toEqual({ kind: 'limit_reached', limit: spent })
  })

  it('points at money the agent cannot reach on another network', () => {
    const spending = spendingOf(status(allRead({}, { tempo: chainRead('tempo', { owner: '20.5' }) })), { now: NOW })
    expect(spending.blocker).toEqual({ kind: 'elsewhere', chain: 'tempo', symbol: 'USDC.e', owner: 20_500_000n })
  })

  it('leads with another network when the agent can spend there and not on Base', () => {
    const arbitrum = chainRead('arbitrum', { owner: '40' })
    const spending = spendingOf(status(allRead({}, { arbitrum }), [...LEDGER, allowance('arbitrum', '10')]), {
      now: NOW,
    })
    expect(spending.spend.chain).toBe('arbitrum')
    expect(micros(spending.available)).toBe(10_000_000n)
    expect(spending.blocker).toBeUndefined()
  })

  it('says access ended once the grant expired', () => {
    const expired = { ...status(allRead({ agent: '5' })) }
    const ended = spendingOf(
      { ...expired, status: { ...expired.status, expiresAt: '2026-10-01T00:00:00Z' } },
      { now: NOW },
    )
    expect(ended.blocker).toEqual({ kind: 'access_ended', at: '2026-10-01T00:00:00Z' })
  })

  it('asks to finish setup when there is no agent', () => {
    const none = { ...status([]), agent: { address: NATIVE } }
    expect(spendingOf(none, { now: NOW }).blocker).toEqual({ kind: 'no_agent' })
    expect(balanceGroups(none)).toEqual([])
  })
})

describe('unknown is not zero', () => {
  it('marks a network whose read failed as unread instead of empty', () => {
    const failedArbitrum = [usdc('arbitrum', 'agent', '0')]
    const groups = balanceGroups(status(allRead({ agent: '1' }, { arbitrum: failedArbitrum })))
    expect(groups.find((group) => group.chain === 'arbitrum')).toMatchObject({ read: false, assets: [] })
    expect(groups.find((group) => group.chain === 'base')).toMatchObject({ read: true, funded: true })
  })

  it('says when the owner holds stablecoins the agent cannot draw on', () => {
    const tempo = chainRead('tempo', { owner: '20.5' })
    const groups = balanceGroups(status(allRead({ owner: '3' }, { tempo }), [...LEDGER, allowance('base', '1')]))
    expect(groups.find((group) => group.chain === 'tempo')?.ownerOutOfReach).toBe(true)
    expect(groups.find((group) => group.chain === 'base')?.ownerOutOfReach).toBe(false)
  })

  it('makes the available amount unknown when Base could not be read', () => {
    const rows = allRead({}).filter((row) => row.chain !== 'base')
    const spending = spendingOf(status([usdc('base', 'agent', '0'), ...rows]), { now: NOW })
    expect(spending.spend.chain).toBe('base')
    expect(spending.available.known).toBe(false)
    expect(spending.blocker).toEqual({ kind: 'unread' })
  })

  it('treats a recorded allowance that could not be read as unknown', () => {
    const setups = [
      {
        chain: 'base' as const,
        upgraded: true,
        allowance: { perHour: '20', expiresAt: LATER, delegationHash: '0xab' },
      },
    ]
    const spending = spendingOf(status(allRead({ owner: '10' })), { now: NOW, setups })
    expect(spending.spend.allowance).toEqual({ kind: 'unknown' })
    expect(spending.available.known).toBe(false)
  })
})

describe('attention and boundaries', () => {
  it('lists approvals first, then unknown outcomes', () => {
    const items = attentionOf(OPERATIONS.toReversed())
    expect(items.map((item) => [item.kind, item.operation.id])).toEqual([
      ['approval', 'op_pending_01'],
      ['uncertain', 'op_send_0003'],
      ['uncertain', 'op_search_0040'],
    ])
    expect(attentionOf(OPERATIONS.filter((operation: Operation) => operation.status === 'delivered'))).toEqual([])
  })

  it('scopes boundaries to the network, marks the binding one and leaves the grant end out', () => {
    const hour = ledger('hour', '20', '4.5')
    const total: LimitView = { layer: 'ledger', period: 'total', limit: '50', enforcedBy: 'This wallet' }
    const tempo: LimitView = { ...allowance('tempo', '1'), layer: 'tempo' }
    const limits = [total, tempo, ledger('week', '50', '50'), hour, ledger('call', '5')]
    const spending = spendingOf(status(allRead({ agent: '30' }), limits), { now: NOW })
    const rows = boundariesOf(spending, limits)
    expect(rows.map((row) => [row.limit.period, row.binding])).toEqual([
      ['call', false],
      ['hour', true],
      ['week', false],
    ])
  })
})
