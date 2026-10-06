import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Schema } from 'effect'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { call, type Person, person } from './owner-requests.ts'

const APP = 'https://goblin.test'
const REDIRECT = 'http://127.0.0.1:9/callback'
const RESOURCE = `${APP}/mcp`
const SIGN_IN_SCOPES = 'openid profile email offline_access'
const ALL_SCOPES = `${SIGN_IN_SCOPES} goblin:inspect`
const Registered = Schema.Struct({ client_id: Schema.String })
const Tokens = Schema.Struct({ access_token: Schema.String, refresh_token: Schema.optional(Schema.String) })
const Redirect = Schema.Struct({ url: Schema.optional(Schema.String), redirect_uri: Schema.optional(Schema.String) })

type Grant = { readonly access: string; readonly refresh: string | undefined; readonly asked: boolean }

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

/** Dynamic registration as Claude Code makes it: no scope, so the client may ask for every /mcp scope. */
async function register(base: string, who: Person): Promise<string> {
  const registered = await auth(base, who, '/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'inspect-fixture',
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  expect(registered.status, await registered.clone().text()).toBe(201)
  return Schema.decodeUnknownSync(Registered)(await registered.json()).client_id
}

type Authorization = {
  readonly scope: string
  /** Force the consent page (`prompt=consent`) even when the standing consent covers the request. */
  readonly prompt?: 'consent'
  /** The scopes the owner grants on the consent page, when narrower than requested. */
  readonly grant?: string
}

/** One sign-in of a registered client to /mcp: authorize, the consent page when the owner must answer, token. */
async function authorize(base: string, who: Person, clientId: string, request: Authorization): Promise<Grant> {
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: request.scope,
    resource: RESOURCE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'fixture',
    ...(request.prompt === undefined ? {} : { prompt: request.prompt }),
  })
  let landing = await next(
    await auth(base, who, `/oauth2/authorize?${query.toString()}`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    }),
  )
  const asked = landing.pathname === '/consent'
  if (asked) {
    // What the consent page reads to say what the client asks for.
    expect(landing.searchParams.get('scope')).toBe(request.scope)
    expect(landing.searchParams.getAll('resource')).toEqual([RESOURCE])
    const consented = await auth(base, who, '/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accept: true,
        oauth_query: landing.search.slice(1),
        ...(request.grant === undefined ? {} : { scope: request.grant }),
      }),
    })
    expect(consented.status, await consented.clone().text()).toBe(200)
    landing = await next(consented)
  }
  const code = landing.searchParams.get('code') ?? ''
  expect(code, landing.href).not.toBe('')
  const tokens = await token(base, who, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  })
  return { access: tokens.access_token, refresh: tokens.refresh_token, asked }
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

/** An MCP client of /mcp with a bearer token, through the real Worker. */
async function connect(base: string, access: string) {
  const client = new Client({ name: 'inspect-fixture', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      fetch: (input, init) => {
        const sent = new Headers(init?.headers)
        sent.set('authorization', `Bearer ${access}`)
        return fetch(input, { ...init, headers: sent })
      },
    }),
  )
  return client
}

/** The tools /mcp lists for a token. */
async function toolsOf(base: string, access: string): Promise<readonly string[]> {
  const client = await connect(base, access)
  try {
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}
const inspection = (tools: readonly string[]) => tools.filter((name) => name.startsWith('inspect_'))
const INSPECTION = [
  'inspect_conversations',
  'inspect_conversation',
  'inspect_turns',
  'inspect_turn',
  'inspect_problems',
]

/** One resource: every metadata path names /mcp and offers inspection; the 401 asks for every scope. */
async function discoveryCase(base: string) {
  for (const path of ['', '/mcp', '/mcp/inspect'])
    expect(await (await fetch(`${base}/.well-known/oauth-protected-resource${path}`)).json(), path).toMatchObject({
      resource: RESOURCE,
      scopes_supported: ALL_SCOPES.split(' '),
    })
  const challenge = await fetch(`${base}/mcp`, { method: 'POST' })
  expect(challenge.status).toBe(401)
  expect(challenge.headers.get('www-authenticate')).toBe(
    `Bearer resource_metadata="${APP}/.well-known/oauth-protected-resource/mcp", scope="${ALL_SCOPES}"`,
  )
  // The first cut's separate endpoints are gone (ADR 0024 amendments).
  expect((await fetch(`${base}/mcp/inspect`, { method: 'POST' })).status).toBe(404)
  expect((await fetch(`${base}/mcp/operator`, { method: 'POST' })).status).toBe(404)
}

/**
 * ADR 0024 end to end on the real Worker, D1 auth store and agents: one /mcp, whose inspection tools a client gets
 * only while the owner's consent grants `goblin:inspect`. Reading needs no plan; asking does.
 */
export async function inspectAuthCase(base: string) {
  await discoveryCase(base)
  const owner = await person(base)
  const clientId = await register(base, owner)

  // Connected for sign-in scopes only, as every client was before inspection joined /mcp: ask, but not inspect.
  const asking = await authorize(base, owner, clientId, { scope: SIGN_IN_SCOPES })
  expect(asking.asked).toBe(true)
  expect([...(await toolsOf(base, asking.access))].toSorted()).toEqual(['ask_agent', 'get_recent_messages'])

  // Reconnecting with inspection asks the owner again, and the same /mcp then offers the tools.
  const inspecting = await authorize(base, owner, clientId, { scope: ALL_SCOPES })
  expect(inspecting.asked).toBe(true)
  expect(inspecting.refresh).toBeDefined()
  const client = await connect(base, inspecting.access)
  try {
    expect(inspection((await client.listTools()).tools.map((tool) => tool.name))).toEqual(INSPECTION)
    const conversations = await client.callTool({ name: 'inspect_conversations', arguments: {} })
    expect(conversations.isError, JSON.stringify(conversations)).toBeFalsy()
    expect(conversations.structuredContent).toMatchObject({ conversations: expect.any(Array) })
    const missing = await client.callTool({ name: 'inspect_turn', arguments: { operationId: 'no-such-turn' } })
    expect(missing).toMatchObject({ isError: true, content: [{ text: '{"_tag":"NotFound","what":"turn"}' }] })
    // Reading needs no plan; asking runs the model and does.
    const refused = await client.callTool({ name: 'ask_agent', arguments: { input: 'hello' } })
    expect(refused).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('SubscriptionRequired') }],
    })
  } finally {
    await client.close()
  }
  // A refreshed token keeps inspection while the consent grants it.
  const refreshed = await token(base, owner, {
    grant_type: 'refresh_token',
    refresh_token: inspecting.refresh ?? '',
    client_id: clientId,
    resource: RESOURCE,
  })
  expect(inspection(await toolsOf(base, refreshed.access_token))).toEqual(INSPECTION)

  // The owner consents again without inspection: tokens already issued lose it at once.
  const narrowed = await authorize(base, owner, clientId, {
    scope: ALL_SCOPES,
    prompt: 'consent',
    grant: SIGN_IN_SCOPES,
  })
  expect(narrowed.asked).toBe(true)
  expect(inspection(await toolsOf(base, refreshed.access_token))).toEqual([])
  expect(inspection(await toolsOf(base, narrowed.access))).toEqual([])

  // Revoking the client in Settings (an account with a plan) ends every token.
  await call(base, owner, '/__test/billing/override', { userId: owner.userId, dailyCredits: 1000 })
  const revoked = await fetch(`${base}/api/clients/${clientId}`, {
    method: 'DELETE',
    headers: { cookie: owner.cookie, origin: APP, 'x-goblin-csrf': '1', 'cf-connecting-ip': owner.ip },
  })
  expect(revoked.status).toBe(200)
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${refreshed.access_token}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  expect(after.status).toBe(401)
}
