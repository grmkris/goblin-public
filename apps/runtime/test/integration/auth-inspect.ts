import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Schema } from 'effect'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { call, type Person, person } from './owner-requests.ts'

const APP = 'https://goblin.test'
const REDIRECT = 'http://127.0.0.1:9/callback'
const Registered = Schema.Struct({ client_id: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.optional(Schema.String) })
const Redirect = Schema.Struct({ url: Schema.optional(Schema.String), redirect_uri: Schema.optional(Schema.String) })

type Grant = { readonly clientId: string; readonly access: string; readonly refresh: string | undefined }

type AuthInit = { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string }
const auth = (base: string, who: Person, path: string, init: AuthInit = {}) =>
  fetch(`${base}/api/auth${path}`, {
    redirect: 'manual',
    ...(init.method === undefined ? {} : { method: init.method }),
    ...(init.body === undefined ? {} : { body: init.body }),
    headers: { cookie: who.cookie, origin: APP, 'cf-connecting-ip': who.ip, ...init.headers },
  })

/** Where an authorize or consent step sends the browser: a redirect, or the provider's JSON `{ url }`. */
async function next(response: Response): Promise<URL> {
  const location = response.headers.get('location')
  if (location !== null) return new URL(location, APP)
  const body = Schema.decodeUnknownSync(Redirect)(await response.json())
  return new URL(body.url ?? body.redirect_uri ?? '', APP)
}

/** An MCP client's whole first connection, as Claude Code makes it: register, authorize, consent, token. */
async function authorize(base: string, who: Person, path: string, scope: string): Promise<Grant> {
  const resource = `${APP}${path}`
  const registered = await auth(base, who, '/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: `inspect-fixture ${path}`,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope,
    }),
  })
  expect(registered.status, await registered.clone().text()).toBe(201)
  const clientId = Schema.decodeUnknownSync(Registered)(await registered.json()).client_id
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope,
    resource,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'fixture',
  })
  const consentUrl = await next(
    await auth(base, who, `/oauth2/authorize?${query.toString()}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    }),
  )
  expect(consentUrl.pathname).toBe('/consent')
  expect(consentUrl.searchParams.getAll('resource')).toEqual([resource])
  const consented = await auth(base, who, '/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accept: true, oauth_query: consentUrl.search.slice(1) }),
  })
  expect(consented.status, await consented.clone().text()).toBe(200)
  const code = (await next(consented)).searchParams.get('code') ?? ''
  expect(code).not.toBe('')
  const tokens = await token(base, who, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource,
  })
  return { clientId, access: tokens.access_token, refresh: tokens.refresh_token }
}

async function token(base: string, who: Person, form: Record<string, string>) {
  const response = await auth(base, who, '/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return Schema.decodeUnknownSync(Tokens)(await response.json())
}

/** An MCP client of one endpoint with a bearer token, through the real Worker. */
async function connect(base: string, path: string, access: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'inspect-fixture', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${path}`), {
      fetch: (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('authorization', `Bearer ${access}`)
        for (const [name, value] of Object.entries(headers)) sent.set(name, value)
        return fetch(input, { ...init, headers: sent })
      },
    }),
  )
  return client
}

const post = (base: string, path: string, access: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })

/** Each endpoint names its own metadata and scope, and the bare metadata path stays `/mcp`. */
async function discoveryCase(base: string) {
  const metadata = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/inspect`)).json()
  expect(metadata).toMatchObject({
    resource: `${APP}/mcp/inspect`,
    scopes_supported: ['goblin:inspect', 'offline_access'],
  })
  expect(await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()).toMatchObject({
    resource: `${APP}/mcp`,
  })
  const challenge = await fetch(`${base}/mcp/inspect`, { method: 'POST' })
  expect(challenge.status).toBe(401)
  expect(challenge.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp/inspect", scope="goblin:inspect offline_access"`,
  )
  // Operator access was withdrawn (ADR 0024 amendment): there is no such endpoint.
  expect((await fetch(`${base}/mcp/operator`, { method: 'POST' })).status).toBe(404)
}

/**
 * ADR 0024 end to end on the real Worker, D1 auth store and agents: an owner's inspection token reads their own
 * agent and nothing else, tokens never cross endpoints, and revoking consent ends access.
 */
export async function inspectAuthCase(base: string) {
  await discoveryCase(base)
  const owner = await person(base)
  const inspect = await authorize(base, owner, '/mcp/inspect', 'goblin:inspect offline_access')
  const ask = await authorize(base, owner, '/mcp', 'openid profile email offline_access')
  expect(inspect.refresh).toBeDefined()

  const client = await connect(base, '/mcp/inspect', inspect.access)
  try {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('inspect_turn')
    const conversations = await client.callTool({ name: 'inspect_conversations', arguments: {} })
    expect(conversations.isError, JSON.stringify(conversations)).toBeFalsy()
    expect(conversations.structuredContent).toMatchObject({ conversations: expect.any(Array) })
    const missing = await client.callTool({ name: 'inspect_turn', arguments: { operationId: 'no-such-turn' } })
    expect(missing).toMatchObject({ isError: true, content: [{ text: '{"_tag":"NotFound","what":"turn"}' }] })
  } finally {
    await client.close()
  }
  // A token is good at its own endpoint only.
  expect((await post(base, '/mcp', inspect.access)).status).toBe(401)
  expect((await post(base, '/mcp/inspect', ask.access)).status).toBe(401)
  // A refreshed token keeps the endpoint's audience and scope.
  const refreshed = await token(base, owner, {
    grant_type: 'refresh_token',
    refresh_token: inspect.refresh ?? '',
    client_id: inspect.clientId,
    resource: `${APP}/mcp/inspect`,
  })
  const again = await connect(base, '/mcp/inspect', refreshed.access_token)
  await again.close()
  // Revoking the client in Settings (an account with a plan) ends inspection at once.
  await call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyTokens: 1000 })
  const revoked = await fetch(`${base}/api/clients/${inspect.clientId}`, {
    method: 'DELETE',
    headers: { cookie: owner.cookie, origin: APP, 'x-goblin-csrf': '1', 'cf-connecting-ip': owner.ip },
  })
  expect(revoked.status).toBe(200)
  expect((await post(base, '/mcp/inspect', refreshed.access_token)).status).toBe(401)
}
