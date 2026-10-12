import { DatabaseSync } from 'node:sqlite'
import { type Operation, termsHash } from '@goblin/wallet/contract'
import * as Schema from 'effect/Schema'
import { describe, expect, test } from 'vitest'
import { defaultWiring, unconfiguredRails, type Wiring } from '../context.ts'
import type { IdentityVerifier } from '../identity.ts'
import { LedgerObject } from '../ledger/durable.ts'
import { termsFor } from '../ledger/fixtures.ts'
import { authClient, WalletAuth } from '../oauth/durable.ts'
import { failure } from '../services/errors.ts'
import type { CheckFinding, PendingUpgrade, PreparedUpgrade, RailsPort } from '../services/rails.ts'
import { testEnv } from '../test-env.ts'
import { createApi } from './index.ts'

const OWNER = '0x1111111111111111111111111111111111111111'
const AGENT = '0x4444444444444444444444444444444444444444'
const STRANGER = '0x3333333333333333333333333333333333333333'
const authorization = { address: OWNER, chainId: 8453, nonce: 0, r: '0x01', s: '0x02', yParity: 0 }

const sqlHost = () => {
  const db = new DatabaseSync(':memory:')
  return {
    storage: {
      sql: { exec: (query: string, ...bindings: unknown[]) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
      transactionSync: <T>(write: () => T): T => write(),
    },
  }
}

/** A prepared upgrade as the rails hand it over; it expires `expiresInMs` from now. */
const pendingUpgrade = (expiresInMs = 300_000): PendingUpgrade => ({
  upgradeId: 'upgrade:base:6f1c2c4e-8b1a-4d0e-9f3a-2b7c5d9e1a40',
  chain: 'base',
  prepared: {
    op: {
      sender: OWNER,
      nonce: 0n,
      callData: '0x',
      callGasLimit: 275_767n,
      verificationGasLimit: 61_585n,
      preVerificationGas: 104_329n,
      maxFeePerGas: 8_855_000n,
      maxPriorityFeePerGas: 1_265_000n,
      paymaster: '0x777777777777AeC03fd955926DbF81597e66834C',
      paymasterData: '0x0200',
      signature: '0x',
    },
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    feeBound: 16_319n,
  },
  createdAt: '2026-10-12T10:00:00.000Z',
  expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
})

const draftOf = (pending: PendingUpgrade): PreparedUpgrade => ({
  kind: 'draft',
  pending,
  typedData: { domain: { chainId: 8453 }, types: {}, primaryType: 'PackedUserOperation', message: { nonce: '0' } },
  maxFeeUsdc: '0.016319',
})

interface SetupOptions {
  readonly fetchFn?: typeof fetch
  readonly live?: boolean
  readonly check?: RailsPort['check']
  readonly prepareUpgrade?: RailsPort['prepareUpgrade']
}

/** Rails that read nothing and confirm every prepared upgrade as `upgradeStatus`, keeping what they were sent. */
const fakeRails = (upgradeStatus: Operation['status'], options: SetupOptions) => {
  const upgrades: { pending: PendingUpgrade; signature: string }[] = []
  const rails: RailsPort = {
    ...unconfiguredRails,
    balances: () => Promise.resolve({ balances: [], unread: [] }),
    allowances: () => Promise.resolve([]),
    ...(options.check === undefined ? {} : { check: options.check }),
    prepareUpgrade: options.prepareUpgrade ?? (() => Promise.resolve(draftOf(pendingUpgrade()))),
    confirmUpgrade: (pending, signature) => {
      upgrades.push({ pending, signature })
      return Promise.resolve({
        id: pending.upgradeId,
        status: upgradeStatus,
        terms: termsFor('0'),
        termsHash: '0xab',
        limitsVersion: 1,
        createdAt: '2026-10-12T10:00:00.000Z',
        updatedAt: '2026-10-12T10:00:00.000Z',
      })
    },
  }
  return { rails, upgrades }
}

const setup = (upgradeStatus: 'confirmed' | 'submitted' | 'failed' = 'confirmed', options: SetupOptions = {}) => {
  const ledger = new LedgerObject(sqlHost(), () => Date.parse('2026-10-12T10:00:00.000Z'))
  const auth = authClient(new WalletAuth(sqlHost()))
  const { rails, upgrades } = fakeRails(upgradeStatus, options)
  const wiring: Wiring = {
    ...defaultWiring,
    fetchFn: options.fetchFn,
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
      testEnv(options.live === true ? { WALLET_LIVE: '1' } : {}),
    )
  return { call, ledger, auth, upgrades }
}

const decodeDraftIds = Schema.decodeUnknownSync(Schema.Struct({ upgradeId: Schema.String, expiresAt: Schema.String }))

/** Prepares the owner's upgrade on Base and reads back its id and expiry. */
const prepareOn = async (call: ReturnType<typeof setup>['call']) =>
  decodeDraftIds(await (await call('POST', '/api/onboarding/upgrade/prepare', { chain: 'base', authorization })).json())

/** Relay as the deposit routes see it: a quote with one deposit address, and one filled request for it. */
const relay: typeof fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.endsWith('/quote'))
    return Response.json({
      steps: [{ id: 'deposit', depositAddress: '0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f', requestId: '0x1791' }],
      details: { currencyOut: { amount: '10158603' }, timeEstimate: 2 },
      fees: { relayer: { amountUsd: '0.032409' } },
    })
  return Response.json({ requests: [{ status: 'success', data: { inTxs: [{ hash: '0xab' }], outTxs: [] } }] })
}

describe('deposit addresses', () => {
  test('quotes a one-off address to the owner on Base or the agent on Tempo, follows it by address; testnets refuse', async () => {
    const { call } = setup('confirmed', { fetchFn: relay, live: true })
    const quote = await call('POST', '/api/deposits', { from: 'base', asset: 'ETH', amount: '0.004', receive: 'USDC' })
    expect(quote.status).toBe(200)
    expect(await quote.json()).toMatchObject({
      depositAddress: '0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f',
      recipient: OWNER,
      expectedOut: '10.158603',
      asset: 'ETH',
      receive: 'USDC',
    })
    const followed = await call('GET', '/api/deposits/0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f')
    expect(await followed.json()).toEqual({
      depositAddress: '0xc9b1672f6fbc38f66d775bb9a5d46b8f0dd2613f',
      status: 'success',
      txHashes: ['0xab'],
    })
    const toTempo = { from: 'arbitrum', asset: 'USDC', amount: '2', receive: 'USDC.e' }
    expect(await (await call('POST', '/api/deposits', toTempo)).json()).toMatchObject({
      error: { message: 'The owner has not created the agent wallet yet.' },
    })
    await call('POST', '/api/onboarding/agent')
    expect(await (await call('POST', '/api/deposits', toTempo)).json()).toMatchObject({
      recipient: AGENT,
      receive: 'USDC.e',
      from: 'arbitrum',
    })
    expect((await call('GET', '/api/deposits/not-an-address')).status).toBe(400)
    const same = await call('POST', '/api/deposits', { from: 'base', asset: 'USDC', amount: '5', receive: 'USDC' })
    expect(await same.json()).toMatchObject({ error: { code: 'deposit_unavailable' } })
    const testnet = setup('confirmed', { fetchFn: relay })
    const refused = await testnet.call('POST', '/api/deposits', {
      from: 'base',
      asset: 'ETH',
      amount: '1',
      receive: 'USDC',
    })
    expect(refused.status).toBe(409)
  })
})

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

  test('me, then onboarding creates the agent once; the upgrade is prepared, signed and recorded once confirmed', async () => {
    const { call, upgrades } = setup()
    expect(await (await call('GET', '/api/me')).json()).toEqual({
      userId: 'did:privy:owner1',
      owner: OWNER,
      chains: [],
    })
    expect((await call('POST', '/api/onboarding/upgrade/prepare', { chain: 'base', authorization })).status).toBe(409)
    const created = await (await call('POST', '/api/onboarding/agent')).json()
    expect(created).toMatchObject({ agent: AGENT, limits: { perHour: '20' } })
    await call('POST', '/api/onboarding/agent')
    const prepared = await call('POST', '/api/onboarding/upgrade/prepare', { chain: 'base', authorization })
    expect(await prepared.json()).toMatchObject({
      chain: 'base',
      upgradeId: 'upgrade:base:6f1c2c4e-8b1a-4d0e-9f3a-2b7c5d9e1a40',
      typedData: { primaryType: 'PackedUserOperation', message: { nonce: '0' } },
      maxFeeUsdc: '0.016319',
    })
    const draft = await prepareOn(call)
    const signature = `0x${'5b'.repeat(65)}`
    const upgraded = await call('POST', '/api/onboarding/upgrade', {
      chain: 'base',
      upgradeId: draft.upgradeId,
      signature,
    })
    expect(await upgraded.json()).toMatchObject({ id: draft.upgradeId, status: 'confirmed' })
    // The rails get back, from the ledger, exactly the operation they prepared.
    expect(upgrades).toEqual([{ pending: { ...pendingUpgrade(), expiresAt: draft.expiresAt }, signature }])
    expect(await (await call('GET', '/api/me')).json()).toMatchObject({ chains: [{ chain: 'base', upgraded: true }] })
  })

  test('a submitted or failed upgrade does not mark the chain upgraded', async () => {
    for (const status of ['submitted', 'failed'] as const) {
      const { call } = setup(status)
      await call('POST', '/api/onboarding/agent')
      const draft = await prepareOn(call)
      const answer = await call('POST', '/api/onboarding/upgrade', {
        chain: 'base',
        upgradeId: draft.upgradeId,
        signature: '0xaa',
      })
      expect(await answer.json()).toMatchObject({ status })
      expect(await (await call('GET', '/api/me')).json()).toMatchObject({ chains: [] })
    }
  })

  test('an unknown, expired or other-chain upgrade is refused before anything is sent', async () => {
    const { call, upgrades } = setup('confirmed', {
      prepareUpgrade: () => Promise.resolve(draftOf(pendingUpgrade(-1))),
    })
    await call('POST', '/api/onboarding/agent')
    const confirm = (upgradeId: string, chain = 'base') =>
      call('POST', '/api/onboarding/upgrade', { chain, upgradeId, signature: '0xaa' })
    expect(await (await confirm('upgrade:base:unknown-1')).json()).toMatchObject({ error: { code: 'upgrade_unknown' } })
    const expired = await prepareOn(call)
    const late = await confirm(expired.upgradeId)
    expect(late.status).toBe(409)
    expect(await late.json()).toMatchObject({ error: { code: 'upgrade_unknown', recovery: 'Prepare it again.' } })
    const fresh = setup()
    await fresh.call('POST', '/api/onboarding/agent')
    const draft = await prepareOn(fresh.call)
    const elsewhere = await fresh.call('POST', '/api/onboarding/upgrade', {
      chain: 'arbitrum',
      upgradeId: draft.upgradeId,
      signature: '0xaa',
    })
    expect(elsewhere.status).toBe(409)
    expect([...upgrades, ...fresh.upgrades]).toEqual([])
  })

  test('an account that already delegates is recorded as upgraded at prepare, with nothing to sign', async () => {
    const operation = {
      id: 'upgrade:base:0x1111111111111111111111111111111111111111:0',
      status: 'confirmed' as const,
      terms: termsFor('0'),
      termsHash: '0xab',
      limitsVersion: 0,
      createdAt: '2026-10-12T10:00:00.000Z',
      updatedAt: '2026-10-12T10:00:00.000Z',
    }
    const { call } = setup('confirmed', { prepareUpgrade: () => Promise.resolve({ kind: 'upgraded', operation }) })
    await call('POST', '/api/onboarding/agent')
    const answer = await call('POST', '/api/onboarding/upgrade/prepare', { chain: 'base', authorization })
    expect(await answer.json()).toEqual({ chain: 'base', operation })
    expect(await (await call('GET', '/api/me')).json()).toMatchObject({ chains: [{ chain: 'base', upgraded: true }] })
  })

  test("a rail's refusal keeps its code and words; a chain or bundler that does not answer is a 502", async () => {
    const poor = setup('confirmed', {
      prepareUpgrade: () => Promise.reject(failure('insufficient_funds', 'Add USDC on Base first.', 409)),
    })
    await poor.call('POST', '/api/onboarding/agent')
    const refused = await poor.call('POST', '/api/onboarding/upgrade/prepare', { chain: 'base', authorization })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toEqual({ error: { code: 'insufficient_funds', message: 'Add USDC on Base first.' } })
    const down = setup('confirmed', { prepareUpgrade: () => Promise.reject(new Error('socket hang up')) })
    await down.call('POST', '/api/onboarding/agent')
    const unanswered = await down.call('POST', '/api/onboarding/upgrade/prepare', { chain: 'base', authorization })
    expect(unanswered.status).toBe(502)
    expect(await unanswered.json()).toMatchObject({ error: { code: 'rail_unavailable' } })
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

  test('check: an uncertain operation is settled, released or left as the chain says, and a settled one is not read', async () => {
    const findings: Record<string, CheckFinding> = {
      'op-check-paid': {
        found: 'paid',
        payment: { rail: 'x402', settledAt: '2026-10-12T10:01:00.000Z' },
        delivered: false,
      },
      'op-check-gone': { found: 'not_paid', reason: 'The payment authorization expired unused; nothing was paid.' },
      'op-check-wait': { found: 'unknown', reason: 'The transaction is not on chain yet.' },
    }
    const reads: string[] = []
    const { call, ledger } = setup('confirmed', {
      check: async (operation) => {
        reads.push(operation.id)
        return findings[operation.id] ?? { found: 'unknown', reason: 'none' }
      },
    })
    const post = (body: unknown) =>
      ledger.fetch(new Request('https://x/call', { method: 'POST', body: JSON.stringify(body) }))
    for (const id of Object.keys(findings)) {
      const terms = termsFor('0.007')
      await post({
        method: 'begin',
        args: [{ id, argsHash: id, terms, termsHash: await termsHash(terms), client: 'goblin' }],
      })
      await post({ method: 'reserve', args: [id] })
      await post({ method: 'signing', args: [id] })
      await post({ method: 'uncertain', args: [id, 'No payment receipt.', { rail: 'x402' }] })
    }
    const check = async (id: string) => (await call('POST', `/api/operations/${id}/check`)).json()
    expect(await check('op-check-paid')).toMatchObject({
      found: 'paid',
      note: 'Paid on Base.',
      operation: { status: 'confirmed' },
    })
    expect(await check('op-check-gone')).toMatchObject({
      found: 'not_paid',
      note: expect.stringContaining('The held amount is released.'),
      operation: { status: 'failed' },
    })
    expect(await check('op-check-wait')).toMatchObject({ found: 'unknown', operation: { status: 'uncertain' } })
    // Settled now: a second check reads nothing and changes nothing.
    expect(await check('op-check-paid')).toMatchObject({ found: 'known', operation: { status: 'confirmed' } })
    expect(reads).toEqual(['op-check-paid', 'op-check-gone', 'op-check-wait'])
    expect((await call('POST', '/api/operations/op-check-none/check')).status).toBe(404)
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
