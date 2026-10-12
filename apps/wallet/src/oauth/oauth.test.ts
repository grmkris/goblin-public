import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import type { IdentityResult, IdentityVerifier } from '../identity.ts'
import { checkAccess, disconnect, insufficientScope, listConnections, revokeOwnerConnections } from './access.ts'
import { fromDurableObjectSql } from '../ledger/sql.ts'
import { WalletAuth, authClient } from './durable.ts'
import { type OAuthDeps, routeOAuth } from './routes.ts'
import { OAuthStore } from './store.ts'
import { pkceChallenge } from './validation.ts'

const ORIGIN = 'https://wallet.test'
const RESOURCE = `${ORIGIN}/mcp`
const REDIRECT = 'https://client.example/callback'
const OWNER = 'did:privy:cmowner0000000000000000001'
const OTHER = 'did:privy:cmother0000000000000000002'
const VERIFIER = 'v'.repeat(43)

/** Bearer `privy-<n>` is signed-in owner n; anything else is refused. */
const fakeIdentity: IdentityVerifier = {
  verifyToken: (token): Promise<IdentityResult> =>
    Promise.resolve(
      token === 'privy-owner'
        ? { ok: true, owner: { userId: OWNER, ownerAddress: '0x00000000000000000000000000000000000000aa' } }
        : token === 'privy-other'
          ? { ok: true, owner: { userId: OTHER, ownerAddress: '0x00000000000000000000000000000000000000bb' } }
          : { ok: false, reason: 'invalid_token' },
    ),
  verifyRequest(request) {
    return this.verifyToken(request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? '')
  },
}

/** A fresh WalletAuth over node:sqlite, reached through its own RPC client, and a clock the test moves. */
const harness = () => {
  const db = new DatabaseSync(':memory:')
  const auth = new WalletAuth({
    storage: {
      sql: { exec: (query, ...bindings) => ({ toArray: () => db.prepare(query).all(...bindings) }) },
      transactionSync: (write) => write(),
    },
  })
  const clock = { ms: 1_800_000_000_000 }
  const deps: OAuthDeps = { store: authClient(auth), identity: fakeIdentity, now: () => clock.ms }
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await routeOAuth(new Request(`${ORIGIN}${path}`, init), deps)
    if (response === undefined) throw new Error(`no OAuth route for ${path}`)
    return response
  }
  return { deps, clock, call }
}

type Harness = ReturnType<typeof harness>

const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
})
const asOwner = (token: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
})

const registerClient = async (h: Harness): Promise<string> => {
  const response = await h.call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'goblin · Wallet', redirect_uris: [REDIRECT] }),
  })
  expect(response.status).toBe(201)
  const body: { client_id: string; token_endpoint_auth_method: string } = await response.json()
  expect(body.token_endpoint_auth_method).toBe('none')
  return body.client_id
}

const authorizeUrl = async (clientId: string, overrides: Record<string, string> = {}) =>
  `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(VERIFIER),
    code_challenge_method: 'S256',
    scope: 'wallet:read wallet:spend offline_access',
    state: 'state-123',
    resource: RESOURCE,
    ...overrides,
  }).toString()}`

/** Authorize → consent approve as `ownerToken`; resolves with the code. */
const approvedCode = async (h: Harness, clientId: string, ownerToken = 'privy-owner'): Promise<string> => {
  const authorize = await h.call(await authorizeUrl(clientId))
  expect(authorize.status).toBe(302)
  const consentUrl = new URL(authorize.headers.get('location') ?? '')
  expect(`${consentUrl.origin}${consentUrl.pathname}`).toBe(`${ORIGIN}/consent`)
  const requestId = consentUrl.searchParams.get('request') ?? ''
  const view = await h.call(`/api/oauth/requests/${requestId}`, asOwner(ownerToken))
  expect(await view.json()).toMatchObject({
    id: requestId,
    client: 'goblin · Wallet',
    redirectHost: 'client.example',
    scopes: ['wallet:read', 'wallet:spend'],
  })
  const decided = await h.call(
    `/api/oauth/requests/${requestId}`,
    asOwner(ownerToken, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }),
  )
  const { redirectTo }: { redirectTo: string } = await decided.json()
  const back = new URL(redirectTo)
  expect(back.searchParams.get('state')).toBe('state-123')
  expect(back.searchParams.get('iss')).toBe(ORIGIN)
  return back.searchParams.get('code') ?? ''
}

interface Tokens {
  readonly access_token: string
  readonly refresh_token: string
  readonly scope: string
}

const exchange = (h: Harness, fields: Record<string, string>) => h.call('/oauth/token', form(fields))

const mcpRequest = (accessToken: string) =>
  new Request(RESOURCE, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } })

/** A live request's end, as the consent view answers it. */
const expiresAt = async (response: Response): Promise<number> => {
  expect(response.status).toBe(200)
  const body: { expiresAt: string; expired?: true } = await response.json()
  expect(body.expired).toBeUndefined()
  return Date.parse(body.expiresAt)
}

describe('OAuth for MCP clients', () => {
  test('metadata names one resource, PKCE S256 and the wallet scopes', async () => {
    const h = harness()
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const body: unknown = await (await h.call(path)).json()
      expect(body).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] })
    }
    const server = await h.call('/.well-known/oauth-authorization-server')
    expect(server.headers.get('access-control-allow-origin')).toBe('*')
    expect(await server.json()).toMatchObject({
      issuer: ORIGIN,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['wallet:read', 'wallet:spend'],
    })
    expect(await routeOAuth(new Request(`${ORIGIN}/api/me`), h.deps)).toBeUndefined()
  })

  test('DCR → authorize → consent → token → refresh rotation → replay revokes the family', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const code = await approvedCode(h, clientId)
    const base = { client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE }
    const first: Tokens = await (
      await exchange(h, { ...base, grant_type: 'authorization_code', code, code_verifier: VERIFIER })
    ).json()
    expect(first.scope).toBe('wallet:read wallet:spend')
    const access = await checkAccess(mcpRequest(first.access_token), h.deps.store, h.clock.ms)
    expect(access.ok && access.grant).toMatchObject({
      ownerUserId: OWNER,
      clientId,
      scopes: ['wallet:read', 'wallet:spend'],
    })

    // The code is single-use.
    const again = await exchange(h, { ...base, grant_type: 'authorization_code', code, code_verifier: VERIFIER })
    expect(again.status).toBe(400)

    // Rotation: the new pair works, the old access token keeps its hour, the old refresh token is spent.
    const refreshFields = { client_id: clientId, resource: RESOURCE, grant_type: 'refresh_token' }
    const second: Tokens = await (await exchange(h, { ...refreshFields, refresh_token: first.refresh_token })).json()
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect((await checkAccess(mcpRequest(second.access_token), h.deps.store, h.clock.ms)).ok).toBe(true)

    // Replay of the spent refresh token revokes the whole family, the new tokens included.
    const replay = await exchange(h, { ...refreshFields, refresh_token: first.refresh_token })
    expect(await replay.json()).toMatchObject({ error: 'invalid_grant' })
    for (const tokenValue of [first.access_token, second.access_token])
      expect((await checkAccess(mcpRequest(tokenValue), h.deps.store, h.clock.ms)).ok).toBe(false)
    const afterReplay = await exchange(h, { ...refreshFields, refresh_token: second.refresh_token })
    expect(afterReplay.status).toBe(400)
    expect(await listConnections(h.deps.store, OWNER)).toEqual([])
  })

  test('a wrong resource, verifier, redirect or client gets no token', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const base = { client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE, grant_type: 'authorization_code' }
    const cases: readonly [string, Record<string, string>, string][] = [
      ['other resource', { resource: 'https://evil.example/mcp' }, 'invalid_target'],
      ['no resource', { resource: '' }, 'invalid_target'],
      ['wrong verifier', { code_verifier: 'w'.repeat(43) }, 'invalid_grant'],
      ['wrong redirect', { redirect_uri: 'https://client.example/other' }, 'invalid_grant'],
      ['wrong client', { client_id: 'gwc_someone_else' }, 'invalid_grant'],
    ]
    for (const [name, override, error] of cases) {
      const code = await approvedCode(h, clientId)
      const response = await exchange(h, { ...base, code, code_verifier: VERIFIER, ...override })
      expect(await response.json(), name).toMatchObject({ error })
    }
    // A token bound to this origin's /mcp does not open another origin's (another stage of the wallet).
    const code = await approvedCode(h, clientId)
    const tokens: Tokens = await (await exchange(h, { ...base, code, code_verifier: VERIFIER })).json()
    const elsewhere = new Request('https://wallet-other.test/mcp', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect((await checkAccess(elsewhere, h.deps.store, h.clock.ms)).ok).toBe(false)
    expect((await checkAccess(mcpRequest(tokens.access_token), h.deps.store, h.clock.ms)).ok).toBe(true)
    // …and the refresh grant refuses another resource too.
    const refresh = await exchange(h, {
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      resource: `${ORIGIN}/elsewhere`,
    })
    expect(await refresh.json()).toMatchObject({ error: 'invalid_target' })
  })

  test('authorize refuses unregistered redirects, plain PKCE and a missing resource without redirecting', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const cases: readonly Record<string, string>[] = [
      { redirect_uri: 'https://evil.example/callback' },
      { client_id: 'gwc_unknown' },
      { code_challenge_method: 'plain' },
      { response_type: 'token' },
      { resource: '' },
      { resource: `${ORIGIN}/mcp/` },
    ]
    for (const override of cases) {
      const response = await h.call(await authorizeUrl(clientId, override))
      expect(response.status, JSON.stringify(override)).toBe(400)
      expect(response.headers.get('location')).toBeNull()
    }
    const badClients = [
      { redirect_uris: ['http://client.example/cb'] },
      { redirect_uris: ['https://user:pw@client.example/cb'] },
      { redirect_uris: [] },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
    ]
    for (const body of badClients) {
      const response = await h.call('/oauth/register', { method: 'POST', body: JSON.stringify(body) })
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
  })

  test('consent needs a signed-in owner, is answered once, and a denial sends access_denied', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const authorize = await h.call(await authorizeUrl(clientId))
    const twice = await h.call(await authorizeUrl(clientId))
    expect(twice.headers.get('location')).toBe(authorize.headers.get('location'))
    const requestId = new URL(authorize.headers.get('location') ?? '').searchParams.get('request') ?? ''
    const path = `/api/oauth/requests/${requestId}`
    expect((await h.call(path)).status).toBe(401)
    expect((await h.call(path, asOwner('privy-forged'))).status).toBe(401)
    const denied = await h.call(path, asOwner('privy-owner', { method: 'POST', body: '{"decision":"deny"}' }))
    const { redirectTo }: { redirectTo: string } = await denied.json()
    expect(new URL(redirectTo).searchParams.get('error')).toBe('access_denied')
    expect(new URL(redirectTo).searchParams.get('code')).toBeNull()
    expect((await h.call(path, asOwner('privy-owner'))).status).toBe(404)
    const late = await h.call(path, asOwner('privy-owner', { method: 'POST', body: '{"decision":"approve"}' }))
    expect(late.status).toBe(404)
  })

  test('an open consent page keeps its request: ten minutes per keep-alive, never past an hour after it opened', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const authorize = await h.call(await authorizeUrl(clientId))
    const requestId = new URL(authorize.headers.get('location') ?? '').searchParams.get('request') ?? ''
    const path = `/api/oauth/requests/${requestId}`
    const opened = h.clock.ms
    expect(await expiresAt(await h.call(path, asOwner('privy-owner')))).toBe(opened + 600_000)
    // Eight minutes in, a keep-alive puts the end ten minutes from now.
    h.clock.ms += 8 * 60_000
    const keep = (token = 'privy-owner') => h.call(`${path}/keep-alive`, asOwner(token, { method: 'POST' }))
    expect(await expiresAt(await keep())).toBe(h.clock.ms + 600_000)
    // The page keeps it alive every two minutes; from fifty minutes in, the hour after opening is the cap.
    for (let minute = 10; minute <= 50; minute += 2) {
      h.clock.ms = opened + minute * 60_000
      expect(await expiresAt(await keep())).toBe(h.clock.ms + 600_000)
    }
    for (const minute of [52, 56, 59]) {
      h.clock.ms = opened + minute * 60_000
      expect(await expiresAt(await keep())).toBe(opened + 3_600_000)
    }
    // Keep-alive is POST only: a GET is not an OAuth route (the owner API answers it 404).
    const get = new Request(`${ORIGIN}${path}/keep-alive`, asOwner('privy-owner'))
    expect(await routeOAuth(get, h.deps)).toBeUndefined()
    // Past the hour it is expired, and stays so: the view says so (the page links back), and answering is refused.
    h.clock.ms = opened + 3_600_000
    for (const response of [await keep(), await h.call(path, asOwner('privy-owner'))]) {
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ expired: true, redirectHost: 'client.example' })
    }
    const late = await h.call(path, asOwner('privy-owner', { method: 'POST', body: '{"decision":"approve"}' }))
    expect(late.status).toBe(404)
  })

  test('the first owner to open a request is bound to it; another owner can neither read, extend nor answer it', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const open = async () => {
      const authorize = await h.call(await authorizeUrl(clientId, { state: `s-${h.clock.ms}` }))
      return `/api/oauth/requests/${new URL(authorize.headers.get('location') ?? '').searchParams.get('request') ?? ''}`
    }
    const read = await open()
    expect((await h.call(read, asOwner('privy-owner'))).status).toBe(200)
    const refused = [
      await h.call(read, asOwner('privy-other')),
      await h.call(`${read}/keep-alive`, asOwner('privy-other', { method: 'POST' })),
      await h.call(read, asOwner('privy-other', { method: 'POST', body: '{"decision":"approve"}' })),
    ]
    for (const response of refused)
      expect(await response.json(), String(response.status)).toMatchObject({ error: { code: 'other_owner' } })
    expect(refused.map((response) => response.status)).toEqual([403, 403, 403])
    // A keep-alive binds as a read does.
    h.clock.ms += 1000
    const kept = await open()
    expect((await h.call(`${kept}/keep-alive`, asOwner('privy-other', { method: 'POST' }))).status).toBe(200)
    expect((await h.call(kept, asOwner('privy-owner'))).status).toBe(403)
    // The bound owner still answers theirs.
    const approved = await h.call(read, asOwner('privy-owner', { method: 'POST', body: '{"decision":"approve"}' }))
    const { redirectTo }: { redirectTo: string } = await approved.json()
    expect(new URL(redirectTo).searchParams.get('code')).toBeTruthy()
  })

  test('a return goes only to the origins of clients the owner connected or has a request bound to', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const now = Math.floor(h.clock.ms / 1000)
    expect(await h.deps.store.returnOrigins(OWNER, now)).toEqual([])
    const authorize = await h.call(await authorizeUrl(clientId))
    const requestId = new URL(authorize.headers.get('location') ?? '').searchParams.get('request') ?? ''
    // Opened but not yet read: bound to nobody.
    expect(await h.deps.store.returnOrigins(OWNER, now)).toEqual([])
    await h.call(`/api/oauth/requests/${requestId}`, asOwner('privy-owner'))
    expect(await h.deps.store.returnOrigins(OWNER, now)).toEqual(['https://client.example'])
    expect(await h.deps.store.returnOrigins(OTHER, now)).toEqual([])
    // Once it expires, only a live connection counts.
    expect(await h.deps.store.returnOrigins(OWNER, now + 601)).toEqual([])
    await approvedCode(h, clientId)
    const code = await approvedCode(h, clientId)
    await exchange(h, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
      grant_type: 'authorization_code',
      code,
      code_verifier: VERIFIER,
    })
    expect(await h.deps.store.returnOrigins(OWNER, now + 601)).toEqual(['https://client.example'])
    await revokeOwnerConnections(h.deps.store, OWNER)
    expect(await h.deps.store.returnOrigins(OWNER, now + 601)).toEqual([])
  })

  test('a request table from before opened_at gains the column, and its open time starts at the first keep-alive', () => {
    const db = new DatabaseSync(':memory:')
    db.prepare(`CREATE TABLE oauth_requests (
      id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
      state TEXT NOT NULL, scopes_json TEXT NOT NULL, resource TEXT NOT NULL, status TEXT NOT NULL, owner TEXT,
      expires_at INTEGER NOT NULL)`).run()
    db.prepare(`INSERT INTO oauth_requests VALUES ('oauth_old','gwc_a','https://a.example/cb','c','','["wallet:read"]',
      'https://wallet.test/mcp','pending',NULL,1000)`).run()
    const host = {
      storage: {
        sql: {
          exec: (query: string, ...bindings: unknown[]) => ({ toArray: () => db.prepare(query).all(...bindings) }),
        },
        transactionSync: <T>(write: () => T): T => write(),
      },
    }
    // Twice: the second start finds the column and leaves the table alone.
    expect(() => new WalletAuth(host)).not.toThrow()
    const store = new OAuthStore(fromDurableObjectSql(host.storage.sql, host.storage.transactionSync))
    store.registerClient({ id: 'gwc_a', name: 'a', redirectUris: ['https://a.example/cb'], now: 0 })
    expect(store.keepAlive('oauth_old', OWNER, 900)).toMatchObject({ expiresAt: 1500, expired: false })
    for (let now = 1400; now <= 3400; now += 500)
      expect(store.keepAlive('oauth_old', OWNER, now)).toMatchObject({ expiresAt: now + 600 })
    for (const now of [3900, 4400, 4499])
      expect(store.keepAlive('oauth_old', OWNER, now)).toMatchObject({ expiresAt: 4500, expired: false })
    expect(store.keepAlive('oauth_old', OWNER, 4500)).toMatchObject({ expiresAt: 4500, expired: true })
  })

  test('codes expire after two minutes and access tokens after an hour', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const base = { client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE, grant_type: 'authorization_code' }
    const stale = await approvedCode(h, clientId)
    h.clock.ms += 121_000
    expect((await exchange(h, { ...base, code: stale, code_verifier: VERIFIER })).status).toBe(400)
    const code = await approvedCode(h, clientId)
    const tokens: Tokens = await (await exchange(h, { ...base, code, code_verifier: VERIFIER })).json()
    h.clock.ms += 3_601_000
    const expired = await checkAccess(mcpRequest(tokens.access_token), h.deps.store, h.clock.ms)
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.response.headers.get('www-authenticate')).toContain('error="invalid_token"')
  })

  test('owners see and revoke only their own connections; RFC 7009 revocation works', async () => {
    const h = harness()
    const clientId = await registerClient(h)
    const base = { client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE, grant_type: 'authorization_code' }
    const mine: Tokens = await (
      await exchange(h, { ...base, code: await approvedCode(h, clientId), code_verifier: VERIFIER })
    ).json()
    const theirs: Tokens = await (
      await exchange(h, { ...base, code: await approvedCode(h, clientId, 'privy-other'), code_verifier: VERIFIER })
    ).json()
    const [connection] = await listConnections(h.deps.store, OWNER)
    expect(connection).toMatchObject({ client: 'goblin · Wallet', scopes: ['wallet:read', 'wallet:spend'] })
    expect(await disconnect(h.deps.store, OTHER, connection?.id ?? '')).toHaveLength(1)
    expect((await checkAccess(mcpRequest(mine.access_token), h.deps.store, h.clock.ms)).ok).toBe(true)
    expect(await disconnect(h.deps.store, OWNER, connection?.id ?? '')).toEqual([])
    expect((await checkAccess(mcpRequest(mine.access_token), h.deps.store, h.clock.ms)).ok).toBe(false)

    await h.call('/oauth/revoke', form({ token: theirs.refresh_token, client_id: 'gwc_wrong' }))
    expect((await checkAccess(mcpRequest(theirs.access_token), h.deps.store, h.clock.ms)).ok).toBe(true)
    expect((await h.call('/oauth/revoke', form({ token: theirs.refresh_token, client_id: clientId }))).status).toBe(200)
    expect((await checkAccess(mcpRequest(theirs.access_token), h.deps.store, h.clock.ms)).ok).toBe(false)
    expect(await revokeOwnerConnections(h.deps.store, OTHER)).toBe(0)
  })

  test('refusals carry the WWW-Authenticate challenge MCP clients follow', async () => {
    const h = harness()
    const missing = await checkAccess(new Request(RESOURCE, { method: 'POST' }), h.deps.store, h.clock.ms)
    expect(missing.ok).toBe(false)
    if (!missing.ok)
      expect(missing.response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      )
    const scope = insufficientScope(ORIGIN, 'wallet:spend')
    expect(scope.status).toBe(403)
    expect(scope.headers.get('www-authenticate')).toContain('error="insufficient_scope", scope="wallet:spend"')
  })
})
