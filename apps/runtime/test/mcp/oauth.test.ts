import { createMcpHandler, Server } from '@modelcontextprotocol/server'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { McpHost } from '../../src/mcp/host.ts'
import { MemoryCredentials, MemoryGrants } from './memory.ts'

const BASE = 'https://fixture.test'
const RESOURCE_METADATA = `${BASE}/.well-known/oauth-protected-resource/mcp`

const mcp = createMcpHandler(() => {
  // oxlint-disable-next-line typescript/no-deprecated -- the low-level Server keeps this fixture independent of tool schema helpers.
  const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
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
    if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === this.refresh) {
      this.refreshCount++
      return this.#issue()
    }
    return Response.json({ error: 'invalid_grant' }, { status: 400 })
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const { pathname } = new URL(request.url)
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
  const host = new McpHost({
    servers: [{ serverId: 'fixture', endpoint: `${BASE}/mcp` }],
    credentials,
    grants: new MemoryGrants(),
    appUrl: 'https://goblin.test',
    fetch: authorizationServer.fetch,
  })
  const connect = async () => {
    const { authorizationUrl } = await host.beginConnect('fixture')
    const params = new URL(authorizationUrl ?? '').searchParams
    expect(params.get('code_challenge_method')).toBe('S256')
    expect(params.get('scope')).toBe('notes offline_access')
    const approval = authorizationServer.approve(authorizationUrl ?? '')
    await host.finishConnect(approval.state, approval.code, undefined)
    return approval
  }
  return { authorizationServer, credentials, host, connect }
}

describe('outbound OAuth connect and refresh (unit, fixture authorization server)', () => {
  it('connects with DCR + PKCE, then calls a granted tool with the stored token', async () => {
    const { host, credentials, connect } = setup()
    try {
      expect(host.servers()[0]?.status).toBe('disconnected')
      const approval = await connect()
      expect(approval.code).toMatch(/^code-/u)
      expect(host.servers()[0]?.status).toBe('connected')
      const tools = await host.tools('fixture', false)
      expect(tools).toEqual([expect.objectContaining({ name: 'read', readOnlyHint: true, granted: false })])
      await expect(host.manager.callTool('fixture', 'read')).rejects.toMatchObject({ _tag: 'GrantDenied' })
      await host.setToolGrant('fixture', 'read', true)
      expect((await host.manager.callTool('fixture', 'read')).content).toEqual([{ type: 'text', text: 'ok' }])
      expect(credentials.pending.size).toBe(0)
    } finally {
      await host.manager.closeAll()
    }
  })

  it('refreshes once when concurrent calls hit an expired access token', async () => {
    const { host, authorizationServer, connect } = setup()
    try {
      await connect()
      await host.setToolGrant('fixture', 'read', true)
      await host.manager.callTool('fixture', 'read')
      authorizationServer.access = 'revoked-server-side'
      const results = await Promise.all([
        host.manager.callTool('fixture', 'read'),
        host.manager.callTool('fixture', 'read'),
      ])
      expect(results.map((result) => result.isError ?? false)).toEqual([false, false])
      expect(authorizationServer.refreshCount).toBe(1)
    } finally {
      await host.manager.closeAll()
    }
  })

  it('marks the server needs_auth when the refresh token is rejected', async () => {
    const { host, authorizationServer, connect } = setup()
    try {
      await connect()
      await host.setToolGrant('fixture', 'read', true)
      authorizationServer.access = 'revoked-server-side'
      authorizationServer.refresh = 'revoked-refresh'
      await expect(host.manager.callTool('fixture', 'read')).rejects.toMatchObject({ _tag: 'NeedsAuthorization' })
      expect(host.servers()[0]?.status).toBe('needs_auth')
    } finally {
      await host.manager.closeAll()
    }
  })

  it('accepts each authorization state once', async () => {
    const { host, authorizationServer } = setup()
    const { authorizationUrl } = await host.beginConnect('fixture')
    const approval = authorizationServer.approve(authorizationUrl ?? '')
    await host.finishConnect(approval.state, approval.code, undefined)
    await expect(host.finishConnect(approval.state, approval.code, undefined)).rejects.toMatchObject({
      _tag: 'InvalidInput',
    })
    await expect(host.finishConnect('forged', 'code', undefined)).rejects.toMatchObject({ _tag: 'InvalidInput' })
  })
})
