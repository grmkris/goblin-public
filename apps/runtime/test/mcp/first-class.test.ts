import { describe, expect, it } from 'vitest'
import { mercatorWallet, profileOf, profileView } from '../../src/mcp/first-class.ts'

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
