import { describe, expect, it } from 'vitest'
import { goblinWallet, mercatorWallet, profileOf, profileView } from '../../src/mcp/first-class.ts'

/** Mercator's `get_connection_status` structured answer, shaped as its output schema says (2026-10-12). */
const status = (overrides: Record<string, unknown> = {}) => ({
  readiness: {
    authorization: 'ready',
    walletBinding: 'ready',
    funding: 'ready',
    spendPolicy: 'ready',
    paidExecution: 'ready',
    confirmationPolicy: 'standing_authorization',
    tokens: [{ symbol: 'USDC.e', balance: '12.5', remainingAllowance: '4.75', spendableNow: '4.75', status: 'ready' }],
  },
  account: {
    accessKey: { expiresAt: null, spendPolicy: 'limited', status: 'active', address: `0x${'a'.repeat(40)}` },
    tokens: [
      {
        address: `0x${'b'.repeat(40)}`,
        authorization: {
          grantLimit: '10',
          periodEndsAt: '2026-10-17T00:00:00Z',
          remainingLimit: '4.75',
          status: 'available',
        },
        balance: { amount: '12.5', status: 'available' },
        symbol: 'USDC.e',
      },
    ],
    walletAddress: `0x${'c'.repeat(40)}`,
  },
  next_action: 'Ready to pay.',
  oauthAuthenticated: true,
  paymentMode: 'hosted_oauth',
  ...overrides,
})

describe('first-class servers (ADR 0043)', () => {
  it('knows Mercator by its exact endpoint, never by a look-alike', () => {
    expect(profileOf('https://mercator.sh/mcp/auth')?.id).toBe('mercator')
    expect(profileOf('https://mercator.sh/mcp')).toBeUndefined()
    expect(profileOf('https://evil.example/mercator.sh/mcp/auth')).toBeUndefined()
    const view = profileView(profileOf('https://mercator.sh/mcp/auth') ?? expect.fail('no profile'))
    expect(view).toMatchObject({
      title: 'Mercator',
      spend: { tool: 'create_job', argument: 'approved_total', currency: 'USD' },
      app: { tool: 'open_mercator' },
      status: true,
      topUp: { url: 'https://mercator.sh/account' },
    })
    expect(view.recommended.ask).toEqual(['create_job'])
    expect(view.recommended.run).not.toContain('create_job')
    expect(Object.keys(view)).not.toContain('endpoints')
  })

  it('knows Cloudflare for publishing: every API call asks first, and how it signs in stays with goblin', () => {
    const cloudflare = profileOf('https://mcp.cloudflare.com/mcp') ?? expect.fail('no profile')
    expect(cloudflare.recommended).toEqual({ run: ['search', 'docs', 'whoami'], ask: ['execute'] })
    expect(cloudflare.scope).toContain('workers-scripts.write')
    expect(Object.keys(profileView(cloudflare))).not.toContain('scope')
  })

  it("reads Mercator's wallet from its status answer: readiness, balance, what is left, and when the period ends", () => {
    expect(mercatorWallet(status())).toEqual({
      kind: 'wallet',
      paid: 'ready',
      funding: 'ready',
      tokens: [{ symbol: 'USDC.e', balance: '12.5', remaining: '4.75', spendable: '4.75' }],
      periodEndsAt: '2026-10-17T00:00:00Z',
    })
  })

  it('bounds what the server says, and reads nothing from an answer that does not fit', () => {
    const long = status({
      readiness: {
        funding: 'blocked',
        paidExecution: 'blocked',
        tokens: Array.from({ length: 12 }, (_, index) => ({ symbol: `T${String(index)}${'x'.repeat(100)}` })),
      },
    })
    const read = mercatorWallet(long)
    expect(read?.tokens).toHaveLength(8)
    expect(read?.tokens[0]?.symbol).toHaveLength(64)
    expect(read).toMatchObject({ paid: 'blocked', funding: 'blocked' })
    expect(mercatorWallet({ readiness: { funding: 'maybe' } })).toBeUndefined()
    expect(mercatorWallet('ready')).toBeUndefined()
  })
})

/** Goblin Wallet's `wallet_status` structured content: goblin's `WalletStatus` under `status`, and what the App shows. */
const walletAnswer = (overrides: Record<string, unknown> = {}) => ({
  status: {
    kind: 'wallet',
    paid: 'ready',
    funding: 'ready',
    tokens: [{ symbol: 'USDC', balance: '25', remaining: '10', spendable: '10' }],
    periodEndsAt: '2026-10-19T00:00:00Z',
    ...overrides,
  },
  owner: { address: `0x${'a'.repeat(40)}`, upgraded: true },
  balances: [],
  limits: [],
  checkedAt: '2026-10-12T00:00:00Z',
})

describe('Goblin Wallet (first-class profile)', () => {
  it('is known at its dev and prod endpoints only, with the owner-facing shape the plan fixes', () => {
    for (const endpoint of ['https://wallet-dev.goblin.surf/mcp', 'https://wallet.goblin.surf/mcp'])
      expect(profileOf(endpoint)?.id).toBe('wallet')
    expect(profileOf('https://wallet.goblin.surf/mcp/')).toBeUndefined()
    expect(profileOf('https://wallet.goblin.surf.evil.example/mcp')).toBeUndefined()
    const view = profileView(profileOf('https://wallet.goblin.surf/mcp') ?? expect.fail('no profile'))
    expect(view).toMatchObject({
      title: 'Goblin Wallet',
      offer: 'so goblin can pay for search and outside services within limits you set',
      spend: { tool: 'paid_fetch', argument: 'max_usd', currency: 'USD' },
      app: { tool: 'wallet_open' },
      status: true,
    })
    expect(view.recommended.ask).toEqual([
      'paid_fetch',
      'transfer',
      'swap_execute',
      'bridge_execute',
      'request_policy_change',
    ])
    expect(view.recommended.run).toContain('wallet_open')
    // Funding the agent from any chain signs and spends nothing, so its App's Add funds runs when needed.
    for (const funding of ['add_funds', 'add_funds_status', 'view_state'])
      expect(view.recommended.run).toContain(funding)
    // Checking an uncertain spend never pays, so it runs when needed; paying again always asks.
    expect(view.recommended.run).toContain('operation_check')
    for (const moving of view.recommended.ask) expect(view.recommended.run).not.toContain(moving)
    expect(profileOf('https://wallet.goblin.surf/mcp')?.statusTool?.name).toBe('wallet_status')
  })

  it('reads where the agent pays from, and nothing while the agent wallet does not exist yet', () => {
    const payFrom = { address: `0x${'b'.repeat(40)}`, chain: 'tempo', token: 'USDC.e', held: '4.93' }
    expect(goblinWallet({ ...walletAnswer(), payFrom })?.payFrom).toEqual(payFrom)
    const unread = { ...payFrom, held: undefined }
    expect(goblinWallet({ ...walletAnswer(), payFrom: unread })?.payFrom).toEqual({
      address: payFrom.address,
      chain: 'tempo',
      token: 'USDC.e',
    })
    expect(goblinWallet({ ...walletAnswer(), payFrom: { ...payFrom, address: `0x${'0'.repeat(40)}` } })?.payFrom).toBe(
      undefined,
    )
    expect(goblinWallet({ ...walletAnswer(), payFrom: { ...payFrom, address: 'not-an-address' } })).toBeUndefined()
    expect(goblinWallet(walletAnswer())?.payFrom).toBeUndefined()
  })

  it("reads the wallet's own status shape from structuredContent.status", () => {
    expect(goblinWallet(walletAnswer())).toEqual({
      kind: 'wallet',
      paid: 'ready',
      funding: 'ready',
      tokens: [{ symbol: 'USDC', balance: '25', remaining: '10', spendable: '10' }],
      periodEndsAt: '2026-10-19T00:00:00Z',
    })
    expect(goblinWallet(walletAnswer({ stablecoinUsd: '5.25', stablecoinUsdPartial: true }))).toMatchObject({
      stablecoinUsd: '5.25',
      stablecoinUsdPartial: true,
    })
    expect(goblinWallet(walletAnswer({ stablecoinUsdPartial: false }))).toBeUndefined()
  })

  it('bounds what the server says, and reads nothing from an answer that does not fit', () => {
    const read = goblinWallet(
      walletAnswer({
        tokens: Array.from({ length: 20 }, () => ({ symbol: 'S'.repeat(500), balance: '9'.repeat(500) })),
      }),
    )
    expect(read?.tokens).toHaveLength(8)
    expect(read?.tokens[0]?.symbol).toHaveLength(64)
    expect(read?.tokens[0]?.balance).toHaveLength(64)
    expect(goblinWallet({ status: { paid: 'ready' } })).toBeUndefined()
    expect(goblinWallet({ status: walletAnswer().status.tokens })).toBeUndefined()
    expect(goblinWallet(walletAnswer({ funding: 'maybe' }))).toBeUndefined()
    expect(goblinWallet({})).toBeUndefined()
    expect(goblinWallet('ready')).toBeUndefined()
    expect(goblinWallet(null)).toBeUndefined()
  })
})
