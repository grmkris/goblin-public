import { describe, expect, test } from 'vitest'
import { defaultWiring, unconfiguredRails, type Wiring } from '../context.ts'
import type { IdentityVerifier } from '../identity.ts'
import { LedgerObject } from '../ledger/durable.ts'
import { alarmHost, T0 } from '../ledger/fixtures.ts'
import { authClient, WalletAuth } from '../oauth/durable.ts'
import { testEnv } from '../test-env.ts'
import { createApi } from './index.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT = '0x4444444444444444444444444444444444444444'

const identity: IdentityVerifier = {
  verifyRequest: () => Promise.resolve({ ok: true, owner: { userId: 'did:privy:owner1', ownerAddress: OWNER } }),
  verifyToken: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
}

/** The owner API over a ledger whose alarm the test reads, with the agent created and an allowance that confirms. */
const onboarded = async (live: boolean) => {
  const host = alarmHost()
  const ledger = new LedgerObject(host, () => T0)
  const wiring: Wiring = {
    ...defaultWiring,
    ledger: () => ledger,
    rails: () => unconfiguredRails,
    createAgent: () => Promise.resolve({ address: AGENT, walletId: 'wallet-1' }),
    allowance: {
      prepare: () => Promise.resolve({ typedData: {}, delegationHash: '0xdd' }),
      confirm: () => Promise.resolve({ perHour: '20', expiresAt: '2026-10-19T10:00:00.000Z', delegationHash: '0xdd' }),
    },
  }
  const api = createApi({ identity: () => identity, auth: () => authClient(new WalletAuth(alarmHost())), wiring })
  const call = (path: string, body?: unknown) =>
    api(
      new Request(`https://wallet.test${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      testEnv(live ? { WALLET_LIVE: '1' } : {}),
    )
  await call('/api/onboarding/agent')
  const confirm = (chain: string) =>
    call('/api/allowance/confirm', { chain, delegationHash: '0xdd', signature: '0xaa' })
  return { host, confirm }
}

describe('seeding the Tempo float', () => {
  test('a confirmed Base allowance on mainnet sets the float alarm, and the answer does not wait for a bridge', async () => {
    const { host, confirm } = await onboarded(true)
    const confirmed = await confirm('base')
    expect(confirmed.status).toBe(200)
    expect(await confirmed.json()).toMatchObject({ chains: [{ chain: 'base', allowance: { perHour: '20' } }] })
    expect(host.alarm.at).toBe(T0)
  })

  test('testnets and an allowance on another chain seed nothing', async () => {
    const testnet = await onboarded(false)
    expect((await testnet.confirm('base')).status).toBe(200)
    expect(testnet.host.alarm.at).toBeNull()
    const arbitrum = await onboarded(true)
    expect((await arbitrum.confirm('arbitrum')).status).toBe(200)
    expect(arbitrum.host.alarm.at).toBeNull()
  })
})
