import { describe, expect, test } from 'vitest'
import { PrivyIdentity, ownerWallet, parseToken, refusalStatus } from './identity.ts'

/** A fixed vector: an ES256 token signed once, offline, by a throwaway P-256 key (public half below). */
const KAT = {
  appId: 'kat-app',
  userId: 'did:privy:cmkatowner0000000000000000',
  jwk: {
    kty: 'EC',
    crv: 'P-256',
    kid: 'kat-key',
    x: 'XfsLgFiGCXaR1eomVEKU1AyYqgtRoeL8O5kAkmGRpoE',
    y: 'DolAJQSqgW3U0Nxv6Z-0IO8KKubXA9oDLOpmqAN7V7Q',
  },
  token:
    'eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImthdC1rZXkifQ.eyJzaWQiOiJzZXNzaW9uLWthdCIsImlzcyI6InByaXZ5LmlvIiwiaWF0IjoxNzkxNzcwMDAwLCJhdWQiOiJrYXQtYXBwIiwic3ViIjoiZGlkOnByaXZ5OmNta2F0b3duZXIwMDAwMDAwMDAwMDAwMDAwIiwiZXhwIjoxNzkxNzczNjAwfQ.E6x_O45YpJ9fc3pL1A8UTVNKGr2mgj4sTO0MCWxh4OdKAS-zKLpj470vYduaiTKruoILgJyJIqHgQxoWVsfw0w',
  /** Between the vector's iat (1791770000) and exp (1791773600). */
  nowMs: 1_791_771_000_000,
} as const

const OWNER = '0x76C70100000000000000000000000000000000aa'
const AGENT = '0xD354C200000000000000000000000000000000bb'

/** Privy's user record as `GET /v1/users/:id` returns it: the owner wallet at index 0, the agent wallet at 1. */
const userRecord = (id: string) => ({
  id,
  linked_accounts: [
    { type: 'email', address: 'owner@example.test' },
    {
      type: 'wallet',
      address: AGENT,
      wallet_index: 1,
      chain_type: 'ethereum',
      wallet_client_type: 'privy',
      connector_type: 'embedded',
    },
    {
      type: 'wallet',
      address: OWNER,
      wallet_index: 0,
      chain_type: 'ethereum',
      wallet_client_type: 'privy',
      connector_type: 'embedded',
    },
  ],
})

interface Call {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A fake Privy: the key set at the JWKS URL, the user record at the users URL; every call recorded. */
const fakePrivy = (overrides: { jwks?: () => Response; user?: () => Response } = {}) => {
  const calls: Call[] = []
  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    if (url === `https://auth.privy.io/api/v1/apps/${KAT.appId}/jwks.json`)
      return Promise.resolve(overrides.jwks?.() ?? Response.json({ keys: [KAT.jwk] }))
    if (url === `https://api.privy.io/v1/users/${encodeURIComponent(KAT.userId)}`)
      return Promise.resolve(overrides.user?.() ?? Response.json(userRecord(KAT.userId)))
    return Promise.resolve(new Response('unexpected', { status: 599 }))
  }
  return { calls, fetchFn }
}

const verifier = (fetchFn: typeof fetch, nowMs: number = KAT.nowMs) =>
  new PrivyIdentity({ appId: KAT.appId, appSecret: 'fixture-secret', fetch: fetchFn, now: () => nowMs })

const tamper = (token: string, part: 0 | 1 | 2, value: string) =>
  token
    .split('.')
    .map((segment, index) => (index === part ? value : segment))
    .join('.')
const b64url = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')

describe('Privy owner identity', () => {
  test('the fixed ES256 vector verifies and names the index-0 wallet, never the agent wallet', async () => {
    const privy = fakePrivy()
    const result = await verifier(privy.fetchFn).verifyToken(KAT.token)
    expect(result).toEqual({ ok: true, owner: { userId: KAT.userId, ownerAddress: OWNER } })
    expect(privy.calls.map((call) => call.init?.redirect)).toEqual(['manual', 'manual'])
    const headers = new Headers(privy.calls[1]?.init?.headers)
    expect(headers.get('privy-app-id')).toBe(KAT.appId)
    expect(headers.get('authorization')).toBe(`Basic ${btoa(`${KAT.appId}:fixture-secret`)}`)
  })

  test('a token minted now by a fresh key verifies through the Bearer header', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
    if (!('privateKey' in keys)) throw new Error('ECDSA generateKey returns a key pair')
    const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
    if (jwk instanceof ArrayBuffer) throw new Error('a JWK export returns JSON')
    const unsigned = `${b64url({ alg: 'ES256', kid: 'fresh' })}.${b64url({
      iss: 'privy.io',
      aud: [KAT.appId, 'other'],
      sub: KAT.userId,
      exp: 2_000,
    })}`
    const raw = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.privateKey,
      new TextEncoder().encode(unsigned),
    )
    const signature = btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '')
    const privy = fakePrivy({
      jwks: () => Response.json({ keys: [KAT.jwk, { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, kid: 'fresh' }] }),
    })
    const request = new Request('https://wallet.test/api/me', {
      headers: { authorization: `Bearer ${unsigned}.${signature}` },
    })
    expect(await verifier(privy.fetchFn, 1_000_000).verifyRequest(request)).toEqual({
      ok: true,
      owner: { userId: KAT.userId, ownerAddress: OWNER },
    })
  })

  test('forged, expired, foreign and malformed tokens are refused before Privy is asked for the user', async () => {
    const [header = '', claims = '', signature = ''] = KAT.token.split('.')
    const forgedClaims = b64url({ iss: 'privy.io', aud: KAT.appId, sub: 'did:privy:someoneelse', exp: 1_791_773_600 })
    const cases: readonly [string, string, number?][] = [
      ['signature from other claims', tamper(KAT.token, 1, forgedClaims)],
      ['flipped signature', tamper(KAT.token, 2, `A${signature.slice(1)}`)],
      ['alg none', tamper(KAT.token, 0, b64url({ alg: 'none' }))],
      ['HS256 header', tamper(KAT.token, 0, b64url({ alg: 'HS256', kid: 'kat-key' }))],
      ['unknown kid', tamper(KAT.token, 0, b64url({ alg: 'ES256', kid: 'other' }))],
      ['expired', KAT.token, 1_791_773_600_000],
      ['issued in the future', KAT.token, 1_791_769_000_000],
      ['two parts', `${header}.${claims}`],
      ['not base64url', `${header}.${claims}.!!!`],
      ['short signature', `${header}.${claims}.AAAA`],
    ]
    for (const [name, token, nowMs] of cases) {
      const privy = fakePrivy()
      const result = await verifier(privy.fetchFn, nowMs).verifyToken(token)
      expect(result, name).toEqual({ ok: false, reason: 'invalid_token' })
      expect(
        privy.calls.some((call) => call.url.startsWith('https://api.privy.io/')),
        name,
      ).toBe(false)
    }
  })

  test('a token for another Privy app is refused without any network call', async () => {
    const privy = fakePrivy()
    const other = new PrivyIdentity({ appId: 'other-app', appSecret: 's', fetch: privy.fetchFn, now: () => KAT.nowMs })
    expect(await other.verifyToken(KAT.token)).toEqual({ ok: false, reason: 'invalid_token' })
    expect(privy.calls).toEqual([])
  })

  test('missing tokens, Privy outages and users without a wallet are told apart', async () => {
    const noHeader = await verifier(fakePrivy().fetchFn).verifyRequest(new Request('https://wallet.test/api/me'))
    expect(noHeader).toEqual({ ok: false, reason: 'missing_token' })
    const cases: readonly [string, Parameters<typeof fakePrivy>[0], string][] = [
      ['JWKS down', { jwks: () => new Response('', { status: 502 }) }, 'privy_unavailable'],
      ['JWKS redirect', { jwks: () => new Response(null, { status: 302 }) }, 'privy_unavailable'],
      ['users API down', { user: () => new Response('', { status: 500 }) }, 'privy_unavailable'],
      ['users API not JSON', { user: () => new Response('<html>') }, 'privy_unavailable'],
      ['user deleted', { user: () => new Response('{}', { status: 404 }) }, 'no_owner_wallet'],
      [
        'only the agent wallet',
        {
          user: () =>
            Response.json({ ...userRecord(KAT.userId), linked_accounts: [userRecord(KAT.userId).linked_accounts[1]] }),
        },
        'no_owner_wallet',
      ],
      ['another user record', { user: () => Response.json(userRecord('did:privy:someoneelse')) }, 'no_owner_wallet'],
    ]
    for (const [name, overrides, reason] of cases)
      expect(await verifier(fakePrivy(overrides).fetchFn).verifyToken(KAT.token), name).toEqual({ ok: false, reason })
    expect([
      refusalStatus('missing_token'),
      refusalStatus('no_owner_wallet'),
      refusalStatus('privy_unavailable'),
    ]).toEqual([401, 409, 503])
  })

  test('the key set and the owner are cached; an unknown kid refetches only after 30 seconds', async () => {
    const privy = fakePrivy()
    let nowMs: number = KAT.nowMs
    const identity = new PrivyIdentity({ appId: KAT.appId, appSecret: 's', fetch: privy.fetchFn, now: () => nowMs })
    await identity.verifyToken(KAT.token)
    await identity.verifyToken(KAT.token)
    expect(privy.calls).toHaveLength(2)
    const unknownKid = tamper(KAT.token, 0, b64url({ alg: 'ES256', kid: 'rotated' }))
    await identity.verifyToken(unknownKid)
    expect(privy.calls).toHaveLength(2)
    nowMs += 31_000
    await identity.verifyToken(unknownKid)
    expect(privy.calls).toHaveLength(3)
  })

  test('the parser and the wallet picker hold their edges', () => {
    expect(parseToken(KAT.token)?.claims.sub).toBe(KAT.userId)
    expect(parseToken('a.b.c.d')).toBeUndefined()
    expect(ownerWallet([{ type: 'wallet', address: OWNER, chain_type: 'ethereum', wallet_client_type: 'privy' }])).toBe(
      OWNER,
    )
    expect(
      ownerWallet([
        { type: 'wallet', address: OWNER, chain_type: 'solana', wallet_client_type: 'privy', wallet_index: 0 },
        { type: 'wallet', address: OWNER, chain_type: 'ethereum', wallet_client_type: 'metamask', wallet_index: 0 },
        { type: 'wallet', address: 'cosmos1x', chain_type: 'ethereum', wallet_client_type: 'privy', wallet_index: 0 },
      ]),
    ).toBeUndefined()
  })
})
