import { createMcpHandler } from '@modelcontextprotocol/server'
import { createHash } from 'node:crypto'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it } from 'vitest'
import { McpConnections } from '../../src/mcp/service.ts'
import { MemoryCredentials, MemoryGrants } from './memory.ts'
import { lowLevelServer } from './low-level-server.ts'
import { hostOf } from './manager.ts'

const BASE = 'https://fixture.test'
const RESOURCE_METADATA = `${BASE}/.well-known/oauth-protected-resource/mcp`

const mcp = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [{ name: 'read', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
  }))
  server.setRequestHandler('tools/call', () => ({ content: [{ type: 'text', text: 'ok' }] }))
  return server
})

/** A minimal OAuth authorization server (metadata, DCR, PKCE code and rotating refresh) in front of an MCP server. */
class FixtureAuthorizationServer {
  access: string | undefined
  refresh: string | undefined
  refreshCount = 0
  /** Every refresh asked for, answered or not. */
  refreshAttempts = 0
  /** While set, the token endpoint answers a refresh only once it settles; `refreshing` hears each one arrive. */
  hold: Promise<void> | undefined
  refreshing: (() => void) | undefined
  /** The client names goblin registered under, in order. */
  readonly registered: unknown[] = []
  readonly #codes = new Map<string, string>()
  #serial = 0

  approve(authorizationUrl: string): { state: string; code: string } {
    const url = new URL(authorizationUrl)
    const code = `code-${++this.#serial}`
    this.#codes.set(code, url.searchParams.get('code_challenge') ?? '')
    return { state: url.searchParams.get('state') ?? '', code }
  }

  #issue(): Response {
    this.access = `access-${++this.#serial}`
    this.refresh = `refresh-${this.#serial}`
    return Response.json({
      access_token: this.access,
      refresh_token: this.refresh,
      token_type: 'Bearer',
      expires_in: 3600,
    })
  }

  async #token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    if (form.get('grant_type') === 'authorization_code') {
      const challenge = this.#codes.get(form.get('code') ?? '')
      this.#codes.delete(form.get('code') ?? '')
      const verifier = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url')
      if (challenge === undefined || challenge !== verifier)
        return Response.json({ error: 'invalid_grant' }, { status: 400 })
      return this.#issue()
    }
    if (form.get('grant_type') === 'refresh_token') {
      this.refreshAttempts++
      this.refreshing?.()
      await this.hold
    }
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === this.refresh) {
      this.refreshCount++
      return this.#issue()
    }
    return Response.json({ error: 'invalid_grant' }, { status: 400 })
  }

  /** Paths no request reaches: a fetch to one fails as a network failure does. */
  readonly unreachable = new Set<string>()

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const { pathname } = new URL(request.url)
    if (this.unreachable.has(pathname)) throw new TypeError('fetch failed')
    if (pathname.startsWith('/.well-known/oauth-protected-resource'))
      return Response.json({ resource: `${BASE}/mcp`, authorization_servers: [BASE] })
    if (pathname === '/.well-known/oauth-authorization-server')
      return Response.json({
        issuer: BASE,
        authorization_endpoint: `${BASE}/authorize`,
        token_endpoint: `${BASE}/token`,
        registration_endpoint: `${BASE}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        // Scopes only on the authorization server, as MyTab publishes them: Connect must still request them.
        scopes_supported: ['notes', 'offline_access'],
      })
    if (pathname === '/register') {
      const metadata: Record<string, unknown> = await request.json()
      this.registered.push(metadata['client_name'])
      return Response.json({ ...metadata, client_id: 'fixture-client' }, { status: 201 })
    }
    if (pathname === '/token') return this.#token(request)
    if (pathname === '/mcp') {
      if (this.access === undefined || request.headers.get('authorization') !== `Bearer ${this.access}`)
        return new Response(null, {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${RESOURCE_METADATA}"` },
        })
      return mcp.fetch(request)
    }
    return new Response(null, { status: 404 })
  }
}

const setup = () => {
  const authorizationServer = new FixtureAuthorizationServer()
  const credentials = new MemoryCredentials()
  const { servers, connections, grants, run, dispose } = hostOf({
    servers: [{ connectionId: 'fixture', endpoint: `${BASE}/mcp`, label: 'Fixture · Hirer' }],
    credentials,
    grants: new MemoryGrants(),
    fetch: authorizationServer.fetch,
  })
  const connect = async () => {
    const { authorizationUrl } = await servers.beginConnect('fixture')
    const params = new URL(authorizationUrl ?? '').searchParams
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('scope')).toBe('notes offline_access')
    const approval = authorizationServer.approve(authorizationUrl ?? '')
    await servers.finishConnect(approval.state, approval.code, undefined)
    return approval
  }
  const status = async () => (await servers.list())[0]?.status
  /** Connected, `read` granted and called once, then the access token revoked server-side. */
  const expired = async () => {
    await connect()
    await grants.setTool('fixture', 'read', true)
    await connections.callTool('fixture', 'read', {})
    authorizationServer.access = 'revoked-server-side'
  }
  return { authorizationServer, credentials, servers, connections, grants, run, dispose, connect, status, expired }
}

describe('outbound OAuth connect and refresh (unit, fixture authorization server)', () => {
  it("connects with DCR + PKCE under the connection's label, then calls a granted tool with the stored token", async () => {
    const { authorizationServer, servers, connections, grants, credentials, connect, status, dispose } = setup()
    try {
      expect(await status()).toBe('disconnected')
      const approval = await connect()
      expect(approval.code).toMatch(/^code-/u)
      expect(authorizationServer.registered).toEqual(['goblin · Fixture · Hirer'])
      expect(await status()).toBe('connected')
      const tools = await servers.tools('fixture', false)
      expect(tools).toEqual([expect.objectContaining({ name: 'read', readOnlyHint: true, granted: false })])
      await expect(connections.callTool('fixture', 'read', {})).rejects.toMatchObject({ _tag: 'GrantDenied' })
      await grants.setTool('fixture', 'read', true)
      expect((await connections.callTool('fixture', 'read', {})).content).toEqual([{ type: 'text', text: 'ok' }])
      expect(credentials.pending.size).toBe(0)
    } finally {
      await dispose()
    }
  })

  it('refreshes once when concurrent calls hit an expired access token, and keeps the rotated refresh token', async () => {
    const { connections, authorizationServer, credentials, expired, dispose } = setup()
    try {
      await expired()
      const results = await Promise.all([
        connections.callTool('fixture', 'read', {}),
        connections.callTool('fixture', 'read', {}),
      ])
      expect(results.map((result) => result.isError ?? false)).toEqual([false, false])
      expect(authorizationServer.refreshCount).toBe(1)
      expect((await credentials.tokens('fixture'))?.refresh_token).toBe(authorizationServer.refresh)
    } finally {
      await dispose()
    }
  })

  it('gives every caller the one refresh that failed', async () => {
    const { connections, authorizationServer, expired, status, dispose } = setup()
    try {
      await expired()
      authorizationServer.refresh = 'revoked-refresh'
      const calls = await Promise.allSettled([
        connections.callTool('fixture', 'read', {}),
        connections.callTool('fixture', 'read', {}),
      ])
      expect(calls).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ _tag: 'NeedsAuthorization' }) },
        { status: 'rejected', reason: expect.objectContaining({ _tag: 'NeedsAuthorization' }) },
      ])
      expect(authorizationServer.refreshAttempts).toBe(1)
      expect(await status()).toBe('needs_auth')
    } finally {
      await dispose()
    }
  })

  it('finishes a refresh whose first caller was interrupted, for the caller that joined it', async () => {
    const { authorizationServer, expired, run, dispose } = setup()
    try {
      await expired()
      const held = Promise.withResolvers<void>()
      const arrived = Promise.withResolvers<void>()
      authorizationServer.hold = held.promise
      authorizationServer.refreshing = arrived.resolve
      const connections = await run(McpConnections)
      const first = await run(Effect.forkDetach(connections.callTool('fixture', 'read', {})))
      await arrived.promise
      const second = run(connections.callTool('fixture', 'read', {}))
      await run(Fiber.interrupt(first))
      held.resolve()
      expect((await second).isError ?? false).toBe(false)
      expect(authorizationServer.refreshAttempts).toBe(1)
      expect(authorizationServer.refreshCount).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('marks the server needs_auth when the refresh token is rejected, a NeedsAuthorization the SDK passes through', async () => {
    const { connections, authorizationServer, expired, status, dispose } = setup()
    try {
      await expired()
      authorizationServer.refresh = 'revoked-refresh'
      await expect(connections.callTool('fixture', 'read', {})).rejects.toMatchObject({ _tag: 'NeedsAuthorization' })
      expect(await status()).toBe('needs_auth')
    } finally {
      await dispose()
    }
  })

  it('keeps the server connected when a refresh cannot reach the token endpoint, and refreshes once it can', async () => {
    const { connections, authorizationServer, expired, status, dispose } = setup()
    try {
      await expired()
      authorizationServer.unreachable.add('/token')
      await expect(connections.callTool('fixture', 'read', {})).rejects.toMatchObject({
        _tag: 'UpstreamMcp',
        reason: 'transport',
      })
      expect(await status()).toBe('connected')
      authorizationServer.unreachable.clear()
      expect((await connections.callTool('fixture', 'read', {})).isError ?? false).toBe(false)
      expect(authorizationServer.refreshCount).toBe(1)
    } finally {
      await dispose()
    }
  })

  it('steps up with a fresh authorization for the scope union, keeping the tokens until the new ones arrive', async () => {
    const { authorizationServer, servers, connections, grants, credentials, connect, dispose } = setup()
    try {
      await connect()
      await grants.setTool('fixture', 'read', true)
      const before = (await credentials.tokens('fixture'))?.access_token
      const refreshes = authorizationServer.refreshAttempts
      const { authorizationUrl } = await servers.beginStepUp('fixture', 'notes:write')
      const params = new URL(authorizationUrl ?? '').searchParams
      expect(params.get('scope')?.split(' ').toSorted()).toEqual(['notes', 'notes:write', 'offline_access'])
      expect(authorizationServer.refreshAttempts).toBe(refreshes)
      expect((await credentials.tokens('fixture'))?.access_token).toBe(before)
      expect((await connections.callTool('fixture', 'read', {})).content).toEqual([{ type: 'text', text: 'ok' }])
      const approval = authorizationServer.approve(authorizationUrl ?? '')
      await servers.finishConnect(approval.state, approval.code, undefined)
      expect((await credentials.tokens('fixture'))?.access_token).not.toBe(before)
      expect((await connections.callTool('fixture', 'read', {})).content).toEqual([{ type: 'text', text: 'ok' }])
    } finally {
      await dispose()
    }
  })

  it('starts no sign-in for a server it cannot reach', async () => {
    const { servers, authorizationServer, status, dispose } = setup()
    try {
      authorizationServer.unreachable.add('/mcp')
      await expect(servers.beginConnect('fixture')).rejects.toMatchObject({ _tag: 'UpstreamMcp', reason: 'transport' })
      expect(await status()).not.toBe('connected')
    } finally {
      await dispose()
    }
  })

  it('accepts each authorization state once', async () => {
    const { servers, authorizationServer, dispose } = setup()
    try {
      const { authorizationUrl } = await servers.beginConnect('fixture')
      const approval = authorizationServer.approve(authorizationUrl ?? '')
      await servers.finishConnect(approval.state, approval.code, undefined)
      await expect(servers.finishConnect(approval.state, approval.code, undefined)).rejects.toMatchObject({
        _tag: 'InvalidInput',
      })
      await expect(servers.finishConnect('forged', 'code', undefined)).rejects.toMatchObject({ _tag: 'InvalidInput' })
    } finally {
      await dispose()
    }
  })
})
