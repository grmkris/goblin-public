import type { ChainBalance } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { unconfiguredRails } from '../../context.ts'
import { LedgerObject, ledgerClient } from '../../ledger/durable.ts'
import { alarmHost } from '../../ledger/fixtures.ts'
import { runWallet } from '../../runtime.ts'
import { walletLayer } from '../index.ts'
import type { RailsPort } from '../rails.ts'
import { readStatusWithSetup } from './status.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT = '0x4444444444444444444444444444444444444444'

const row = (chain: 'base' | 'tempo', holder: 'owner' | 'agent', symbol: string, balance: string): ChainBalance => ({
  chain,
  symbol,
  token: chain === 'base' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x20c000000000000000000000b9537d11c60e8b50',
  decimals: 6,
  balance,
  holder,
  address: holder === 'owner' ? OWNER : AGENT,
})

/** A wallet with its agent and a Base allowance, whose rails read 0.4 USDC.e on Tempo and 12.5 USDC on Base. */
const wallet = async (live: boolean) => {
  const ledger = ledgerClient(new LedgerObject(alarmHost(), Date.now))
  await ledger.updateProfile({
    ownerAddress: OWNER,
    agentAddress: AGENT,
    chains: [
      {
        chain: 'base',
        upgraded: true,
        allowance: {
          perHour: '20',
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          delegationHash: '0xdd',
        },
      },
    ],
  })
  const rails: RailsPort = {
    ...unconfiguredRails,
    balances: () =>
      Promise.resolve({
        balances: [row('base', 'owner', 'USDC', '12.5'), row('tempo', 'agent', 'USDC.e', '0.4')],
        unread: [],
        live,
      }),
    allowances: () =>
      Promise.resolve([
        { layer: 'onchain', period: 'hour', limit: '20', remaining: '20', chain: 'base', enforcedBy: 'Base' },
      ]),
  }
  const read = () =>
    runWallet(readStatusWithSetup, walletLayer({ ledger, signer: undefined, rails, origin: 'https://w' }))
  return { ledger, read }
}

describe('wallet_status and the Tempo float', () => {
  test('one balance: the total stays owner plus agent, and the float says the allowance keeps it topped up', async () => {
    const { read } = await wallet(true)
    const status = await read()
    if (!status.ok) throw new Error(status.failure.message)
    expect(status.value.result.status.stablecoinUsd).toBe('12.9')
    expect(status.value.result.float).toEqual({ held: '0.4', low: '1', target: '3', refilling: false, automatic: true })
    expect(status.value.float).toEqual({ source: 'allowance', refilling: false })
  })

  test('a refill in flight shows as refilling; on testnets the float is not automatic', async () => {
    const { ledger, read } = await wallet(true)
    await ledger.claimFloat({
      terms: {
        kind: 'bridge',
        chain: 'base',
        rail: 'relay',
        subject: 'Moved $2.60 to Tempo for paid inference',
        token: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
        amount: '2.6',
        amountUsd: '2.6',
        recipient: AGENT,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      },
      termsHash: '0xab',
    })
    const flying = await read()
    expect(flying.ok && flying.value.result.float?.refilling).toBe(true)
    const testnet = await (await wallet(false)).read()
    expect(testnet.ok && testnet.value.result.float?.automatic).toBe(false)
  })
})
