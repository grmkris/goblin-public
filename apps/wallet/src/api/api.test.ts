import { DatabaseSync } from 'node:sqlite'
import { termsHash } from '@goblin/wallet/contract'
import { describe, expect, test } from 'vitest'
import { defaultWiring, unconfiguredRails, type Wiring } from '../context.ts'
import type { IdentityVerifier } from '../identity.ts'
import { LedgerObject } from '../ledger/durable.ts'
import { termsFor } from '../ledger/fixtures.ts'
import { authClient, WalletAuth } from '../oauth/durable.ts'
import type { RailsPort } from '../services/rails.ts'
import { testEnv } from '../test-env.ts'
import { createApi } from './index.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT = '0x4444444444444444444444444444444444444444'
const STRANGER = '0x3333333333333333333333333333333333333333'

const sqlHost = () => {
  const db = new DatabaseSync(':memory:')
  return {
    storage: {
      sql: { exec: (query: string, ...bindings: unknown[]) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
      transactionSync: <T>(write: () => T): T => write(),
    },
  }
}

const setup = (upgradeStatus: 'confirmed' | 'submitted' | 'failed' = 'confirmed') => {
  const ledger = new LedgerObject(sqlHost(), () => Date.parse('2026-10-12T10:00:00.000Z'))
  const auth = authClient(new WalletAuth(sqlHost()))
  const upgrades: unknown[] = []
  const rails: RailsPort = {
    ...unconfiguredRails,
    balances: () => Promise.resolve([]),
    allowances: () => Promise.resolve([]),
    upgrade: (request) => {
      upgrades.push(request)
      return Promise.resolve({
        id: 'op-upgrade-1',
        status: upgradeStatus,
        terms: termsFor('0'),
        termsHash: '0xab',
        limitsVersion: 1,
        createdAt: '2026-10-12T10:00:00.000Z',
        updatedAt: '2026-10-12T10:00:00.000Z',
      })
    },
  }
  const wiring: Wiring = {
    ...defaultWiring,
    ledger: () => ledger,
    rails: () => rails,
    createAgent: () => Promise.resolve({ address: AGENT, walletId: 'wallet-1' }),
    allowance: {
      prepare: () => Promise.resolve({ typedData: { primaryType: 'Delegation' }, delegationHash: '0xdd' }),
      confirm: () => Promise.resolve({ perHour: '20', expiresAt: '2026-10-19T10:00:00.000Z', delegationHash: '0xdd' }),
    },
  }
  const identity: IdentityVerifier = {
    verifyRequest: (request) =>
      Promise.resolve(
        request.headers.get('authorization') === 'Bearer owner'
          ? { ok: true, owner: { userId: 'did:privy:owner1', ownerAddress: OWNER } }
          : { ok: false, reason: 'missing_token' },
      ),
    verifyToken: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
  }
  const api = createApi({ identity: () => identity, auth: () => auth, wiring })
  const call = (method: string, path: string, body?: unknown, token = 'owner') =>
    api(
      new Request(`https://wallet.test${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      testEnv(),
    )
  return { call, ledger, auth, upgrades }
}

describe('the owner API', () => {
  test('refuses a request without a Privy token', async () => {
    const { call } = setup()
    const response = await call('GET', '/api/me', undefined, 'nobody')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'missing_token' } })
  })

  test('unknown routes are 404 and wrong methods 405, as the error envelope', async () => {
    const { call } = setup()
    expect((await call('GET', '/api/nope')).status).toBe(404)
    expect(await (await call('PATCH', '/api/me')).json()).toMatchObject({ error: { code: 'method_not_allowed' } })
  })

  test('me, then onboarding creates the agent once and upgrade records the chain', async () => {
    const { call, upgrades } = setup()
    expect(await (await call('GET', '/api/me')).json()).toEqual({
      userId: 'did:privy:owner1',
      owner: OWNER,
      chains: [],
    })
    const created = await (await call('POST', '/api/onboarding/agent')).json()
    expect(created).toMatchObject({ agent: AGENT, limits: { perHour: '20' } })
    await call('POST', '/api/onboarding/agent')
    const authorization = { address: OWNER, chainId: 8453, nonce: 0, r: '0x01', s: '0x02', yParity: 0 }
    const upgraded = await call('POST', '/api/onboarding/upgrade', { chain: 'base', authorization })
    expect(upgraded.status).toBe(200)
    expect(upgrades).toHaveLength(1)
    expect(await (await call('GET', '/api/me')).json()).toMatchObject({ chains: [{ chain: 'base', upgraded: true }] })
  })

  test('a submitted or failed upgrade does not mark the chain upgraded', async () => {
    for (const status of ['submitted', 'failed'] as const) {
      const { call } = setup(status)
      await call('POST', '/api/onboarding/agent')
      const authorization = { address: OWNER, chainId: 8453, nonce: 0, r: '0x01', s: '0x02', yParity: 0 }
      const answer = await call('POST', '/api/onboarding/upgrade', { chain: 'base', authorization })
      expect(await answer.json()).toMatchObject({ status })
      expect(await (await call('GET', '/api/me')).json()).toMatchObject({ chains: [] })
    }
  })

  test('the allowance routes need the agent first, then record the confirmed allowance', async () => {
    const { call } = setup()
    const prepare = { chain: 'base', perHour: '20', days: 7 }
    expect((await call('POST', '/api/allowance/prepare', prepare)).status).toBe(409)
    await call('POST', '/api/onboarding/agent')
    expect(await (await call('POST', '/api/allowance/prepare', prepare)).json()).toMatchObject({
      chain: 'base',
      delegationHash: '0xdd',
    })
    const confirmed = await call('POST', '/api/allowance/confirm', {
      chain: 'base',
      delegationHash: '0xdd',
      signature: '0xaa',
    })
    expect(await confirmed.json()).toMatchObject({
      chains: [{ chain: 'base', allowance: { perHour: '20', delegationHash: '0xdd' } }],
    })
  })

  test('limits: the layers, then the owner changes the ledger limits', async () => {
    const { call } = setup()
    expect(await (await call('GET', '/api/limits')).json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ layer: 'ledger', period: 'week' })]),
    )
    const put = await call('PUT', '/api/limits', {
      perCall: '2',
      perHour: '10',
      perWeek: '30',
      expiresAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    })
    expect(await put.json()).toMatchObject({ perCall: '2', version: 2 })
    const bad = await call('PUT', '/api/limits', {
      perCall: '20',
      perHour: '10',
      perWeek: '30',
      expiresAt: '2026-11-01T00:00:00.000Z',
      version: 1,
    })
    expect(bad.status).toBe(400)
    expect((await call('PUT', '/api/limits', { nonsense: true })).status).toBe(400)
  })

  test('approvals: view, a decision on the wrong hash is refused, the right one lands', async () => {
    const { call, ledger } = setup()
    const terms = termsFor('1', { kind: 'transfer', rail: 'transfer', recipient: STRANGER, subject: 'transfer' })
    const hash = await termsHash(terms)
    const post = (body: unknown) =>
      ledger.fetch(new Request('https://x/call', { method: 'POST', body: JSON.stringify(body) }))
    await post({
      method: 'begin',
      args: [{ id: 'op-approve-01', argsHash: 'a', terms, termsHash: hash, client: 'Claude' }],
    })
    await post({ method: 'reserve', args: ['op-approve-01'] })
    const view = await (await call('GET', '/api/approvals/op-approve-01')).json()
    expect(view).toMatchObject({ reason: 'new_recipient', status: 'pending', termsHash: hash, client: 'Claude' })
    const wrong = await call('POST', '/api/approvals/op-approve-01', { decision: 'approve', termsHash: '0xbad' })
    expect(wrong.status).toBe(409)
    expect(await wrong.json()).toMatchObject({ error: { code: 'terms_changed' } })
    const ok = await call('POST', '/api/approvals/op-approve-01', {
      decision: 'approve',
      termsHash: hash,
      remember: true,
    })
    expect(await ok.json()).toMatchObject({ status: 'approved' })
    expect((await call('POST', '/api/approvals/op-approve-01', { decision: 'approve', termsHash: hash })).status).toBe(
      409,
    )
    expect((await call('GET', '/api/approvals/op-missing-01')).status).toBe(404)
    expect(await (await call('GET', '/api/address-book')).json()).toMatchObject([{ address: STRANGER.toLowerCase() }])
    expect(await (await call('GET', '/api/activity')).json()).toMatchObject([{ id: 'op-approve-01' }])
  })

  test("services lists the allowlist; status serves goblin's shape", async () => {
    const { call } = setup()
    expect(await (await call('GET', '/api/services')).json()).toMatchObject([
      { id: 'exa.search' },
      { id: 'exa.contents' },
    ])
    expect(await (await call('GET', '/api/status')).json()).toMatchObject({
      status: { kind: 'wallet', paid: 'blocked' },
      recent: [],
    })
  })

  test('connections list and disconnect, and revoke stops the ledger', async () => {
    const { call, auth, ledger } = setup()
    expect(await (await call('GET', '/api/connections')).json()).toEqual([])
    expect((await call('DELETE', '/api/connections/missing-1')).status).toBe(200)
    expect(await auth.connections('did:privy:owner1')).toEqual([])
    const revoked = await call('POST', '/api/revoke')
    expect(revoked.status).toBe(200)
    const answer = await (
      await ledger.fetch(
        new Request('https://x/call', { method: 'POST', body: JSON.stringify({ method: 'isRevoked', args: [] }) }),
      )
    ).json()
    expect(answer).toEqual({ result: true })
  })

  test('policy changes: list, decide once, then a second decision is 409', async () => {
    const { call, ledger } = setup()
    expect(await (await call('GET', '/api/policy-changes')).json()).toEqual([])
    await ledger.fetch(
      new Request('https://x/call', {
        method: 'POST',
        body: JSON.stringify({
          method: 'recordPolicyChange',
          args: ['pc-1', 'raise hourly to $30', 'big batch', 'agent'],
        }),
      }),
    )
    expect(await (await call('GET', '/api/policy-changes')).json()).toMatchObject([
      { id: 'pc-1', change: 'raise hourly to $30', client: 'agent', status: 'pending' },
    ])
    const decided = await call('POST', '/api/policy-changes/pc-1', { decision: 'dismissed' })
    expect(decided.status).toBe(200)
    expect(await decided.json()).toMatchObject({ id: 'pc-1', status: 'dismissed' })
    expect((await call('POST', '/api/policy-changes/pc-1', { decision: 'applied' })).status).toBe(409)
    expect((await call('POST', '/api/policy-changes/nope', { decision: 'applied' })).status).toBe(404)
    expect((await call('POST', '/api/policy-changes/pc-1', { decision: 'maybe' })).status).toBe(400)
    expect((await call('GET', '/api/policy-changes', undefined, 'stranger')).status).toBe(401)
  })
})
