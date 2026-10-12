import { OAuthDecision } from '@goblin/wallet/contract'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { WalletEnv } from '../env.ts'
import { type IdentityVerifier, identityFor, refusalStatus } from '../identity.ts'
import { type AuthApi, authStore } from './durable.ts'
import {
  OAUTH_SCOPES,
  PKCE_CHALLENGE,
  PKCE_VERIFIER,
  grantedScopes,
  mcpResource,
  pkceChallenge,
  randomToken,
  tokenHash,
  validRedirect,
} from './validation.ts'

/**
 * Goblin Wallet's OAuth 2.1 authorization server for MCP clients, ported from Sidequest's `apps/api/src/oauth.ts`
 * without its agent selection: one owner holds one wallet, and a connection is one client's grant to it.
 *
 * - `/.well-known/oauth-protected-resource[/mcp]` and `/.well-known/oauth-authorization-server`: RFC 9728 and 8414.
 * - `POST /oauth/register`: dynamic registration of public clients (PKCE, no secret).
 * - `GET /oauth/authorize`: checks the client, then sends the browser to the web app's `/consent?request=<id>`.
 * - `GET|POST /api/oauth/requests/:id`: the consent page reads and answers the request as the signed-in owner.
 * - `POST /oauth/token`: code + PKCE S256, rotating refresh tokens; a replayed refresh token revokes its family.
 * - `POST /oauth/revoke`: RFC 7009.
 * Every token is bound to the resource `<origin>/mcp`.
 */

export interface OAuthDeps {
  readonly store: AuthApi
  readonly identity: IdentityVerifier
  /** Epoch milliseconds. */
  readonly now: () => number
}

export const oauthDeps = (env: WalletEnv): OAuthDeps => ({
  store: authStore(env.AUTH),
  identity: identityFor(env),
  now: () => Date.now(),
})

const MAX_BODY = 16_384
const CLIENT_NAME_MAX = 120

const PUBLIC = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
} as const

const json = (body: unknown, status = 200, cors = false): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(cors ? PUBLIC : {}),
    },
  })

/** An RFC 6749 error, for the protocol endpoints clients call directly. */
const oauthError = (error: string, description: string, status = 400): Response =>
  json({ error, error_description: description }, status, true)

/** The owner API's error envelope, for the consent routes. */
const apiError = (code: string, message: string, status: number): Response => json({ error: { code, message } }, status)

const seconds = (deps: OAuthDeps): number => Math.floor(deps.now() / 1000)

const Fields = Schema.Record(Schema.String, Schema.Unknown)
const decodeFields = Schema.decodeUnknownOption(Schema.fromJsonString(Fields))

/** A small form or JSON body as a string map; undefined when it is too large or neither. */
const readFields = async (request: Request): Promise<Record<string, unknown> | undefined> => {
  const text = await request.text()
  if (text.length > MAX_BODY) return undefined
  const type = request.headers.get('content-type') ?? ''
  if (type.startsWith('application/x-www-form-urlencoded'))
    return Object.fromEntries(new URLSearchParams(text).entries())
  return Option.getOrUndefined(decodeFields(text))
}

const field = (fields: Record<string, unknown>, name: string): string => {
  const value = fields[name]
  return typeof value === 'string' ? value : ''
}

const protectedResource = (origin: string): Response =>
  json(
    {
      resource: mcpResource(origin),
      resource_name: 'Goblin Wallet',
      authorization_servers: [origin],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ['header'],
    },
    200,
    true,
  )

const authorizationServer = (origin: string): Response =>
  json(
    {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      revocation_endpoint: `${origin}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: OAUTH_SCOPES,
      authorization_response_iss_parameter_supported: true,
    },
    200,
    true,
  )

const GRANT_TYPES = new Set(['authorization_code', 'refresh_token'])

const register = async (request: Request, deps: OAuthDeps): Promise<Response> => {
  const body = await readFields(request)
  if (body === undefined) return oauthError('invalid_client_metadata', 'Send the client metadata as JSON')
  const redirectUris = body['redirect_uris']
  if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 8)
    return oauthError('invalid_redirect_uri', 'Register one to eight redirect URIs')
  if (!redirectUris.every(validRedirect))
    return oauthError('invalid_redirect_uri', 'Redirect URIs must be exact HTTPS URLs, or HTTP on localhost')
  const auth = body['token_endpoint_auth_method']
  if (auth !== undefined && auth !== 'none')
    return oauthError('invalid_client_metadata', 'Only public clients with PKCE are supported')
  const grants = body['grant_types']
  if (grants !== undefined && !(Array.isArray(grants) && grants.every((grant) => GRANT_TYPES.has(String(grant)))))
    return oauthError('invalid_client_metadata', 'Supported grants: authorization_code and refresh_token')
  const id = randomToken('gwc_').slice(0, 36)
  const name = field(body, 'client_name').trim().slice(0, CLIENT_NAME_MAX) || 'MCP client'
  const now = seconds(deps)
  await deps.store.registerClient({ id, name, redirectUris, now })
  return json(
    {
      client_id: id,
      client_id_issued_at: now,
      client_name: name,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: OAUTH_SCOPES.join(' '),
    },
    201,
    true,
  )
}

const authorize = async (url: URL, deps: OAuthDeps): Promise<Response> => {
  const query = url.searchParams
  const clientId = query.get('client_id') ?? ''
  const redirectUri = query.get('redirect_uri') ?? ''
  const client = clientId === '' ? undefined : await deps.store.client(clientId)
  // Never redirect to a URI the client did not register: answer here instead.
  if (client === undefined || !client.redirectUris.includes(redirectUri))
    return oauthError('invalid_request', 'Unknown client, or a redirect URI it did not register')
  const challenge = query.get('code_challenge') ?? ''
  if (
    query.get('response_type') !== 'code' ||
    query.get('code_challenge_method') !== 'S256' ||
    !PKCE_CHALLENGE.test(challenge)
  )
    return oauthError('invalid_request', 'Use response_type=code with a PKCE S256 code_challenge')
  if (query.get('resource') !== mcpResource(url.origin))
    return oauthError('invalid_target', `Name the resource ${mcpResource(url.origin)} explicitly`)
  const id = await deps.store.openRequest({
    id: `oauth_${randomToken('').slice(0, 40)}`,
    clientId,
    redirectUri,
    codeChallenge: challenge,
    state: (query.get('state') ?? '').slice(0, 512),
    scopes: grantedScopes(query.get('scope')),
    resource: mcpResource(url.origin),
    now: seconds(deps),
  })
  return new Response(null, {
    status: 302,
    headers: { location: `${url.origin}/consent?request=${encodeURIComponent(id)}`, 'cache-control': 'no-store' },
  })
}

const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString()

const decodeDecision = Schema.decodeUnknownOption(OAuthDecision)

/** `GET|POST /api/oauth/requests/:id`, as the owner signed in to the web app with Privy. */
const consent = async (request: Request, id: string, deps: OAuthDeps): Promise<Response> => {
  const who = await deps.identity.verifyRequest(request)
  if (!who.ok) return apiError(who.reason, 'Sign in to the wallet to answer this request.', refusalStatus(who.reason))
  const pending = await deps.store.pendingRequest(id, seconds(deps))
  if (pending === undefined)
    return apiError('request_gone', 'This sign-in request expired or was already answered.', 404)
  if (request.method === 'GET')
    return json({
      id,
      client: pending.clientName,
      redirectHost: new URL(pending.redirectUri).host,
      scopes: pending.scopes,
      expiresAt: iso(pending.expiresAt),
    })
  const decision = Option.getOrUndefined(decodeDecision(await readFields(request)))
  if (decision === undefined) return apiError('bad_request', 'Send {"decision": "approve" | "deny"}.', 400)
  const approve = decision.decision === 'approve'
  const code = randomToken('gwo_')
  const decided = await deps.store.decide({
    id,
    owner: who.owner.userId,
    approve,
    codeHash: await tokenHash(code),
    now: seconds(deps),
  })
  if (decided === undefined) return apiError('request_gone', 'This sign-in request was already answered.', 409)
  const target = new URL(decided.redirectUri)
  if (approve) target.searchParams.set('code', code)
  else target.searchParams.set('error', 'access_denied')
  if (decided.state !== '') target.searchParams.set('state', decided.state)
  target.searchParams.set('iss', new URL(request.url).origin)
  return json({ redirectTo: target.href })
}

interface Minted {
  readonly access: string
  readonly refresh: string
  readonly accessHash: string
  readonly refreshHash: string
}

const mint = async (): Promise<Minted> => {
  const access = randomToken('gwa_')
  const refresh = randomToken('gwr_')
  return { access, refresh, accessHash: await tokenHash(access), refreshHash: await tokenHash(refresh) }
}

const tokenReply = (minted: Minted, scopes: readonly string[]): Response =>
  json(
    {
      access_token: minted.access,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: minted.refresh,
      scope: scopes.join(' '),
    },
    200,
    true,
  )

const codeGrant = async (fields: Record<string, unknown>, origin: string, deps: OAuthDeps): Promise<Response> => {
  const verifier = field(fields, 'code_verifier')
  if (!PKCE_VERIFIER.test(verifier)) return oauthError('invalid_grant', 'Send the PKCE code_verifier')
  if (field(fields, 'resource') !== mcpResource(origin))
    return oauthError('invalid_target', `Name the resource ${mcpResource(origin)}`)
  const minted = await mint()
  const issued = await deps.store.exchangeCode({
    codeHash: await tokenHash(field(fields, 'code')),
    clientId: field(fields, 'client_id'),
    redirectUri: field(fields, 'redirect_uri'),
    resource: mcpResource(origin),
    challenge: await pkceChallenge(verifier),
    familyId: `conn_${randomToken('').slice(0, 32)}`,
    accessHash: minted.accessHash,
    refreshHash: minted.refreshHash,
    now: seconds(deps),
  })
  if (issued === undefined)
    return oauthError('invalid_grant', 'The code expired or was used, or its client, redirect or verifier differ')
  return tokenReply(minted, issued.scopes)
}

const refreshGrant = async (fields: Record<string, unknown>, origin: string, deps: OAuthDeps): Promise<Response> => {
  const resource = field(fields, 'resource')
  if (resource !== '' && resource !== mcpResource(origin))
    return oauthError('invalid_target', `Name the resource ${mcpResource(origin)}`)
  const minted = await mint()
  const issued = await deps.store.refresh({
    refreshHash: await tokenHash(field(fields, 'refresh_token')),
    clientId: field(fields, 'client_id'),
    resource: resource === '' ? null : resource,
    accessHash: minted.accessHash,
    newRefreshHash: minted.refreshHash,
    now: seconds(deps),
  })
  if (issued === 'replayed')
    return oauthError('invalid_grant', 'This refresh token was already used; the connection is revoked')
  if (issued === 'invalid') return oauthError('invalid_grant', 'The refresh token expired or was revoked')
  return tokenReply(minted, issued.scopes)
}

const token = async (request: Request, deps: OAuthDeps): Promise<Response> => {
  const fields = await readFields(request)
  if (fields === undefined) return oauthError('invalid_request', 'Send a form-encoded token request')
  const origin = new URL(request.url).origin
  const grant = field(fields, 'grant_type')
  if (grant === 'authorization_code') return codeGrant(fields, origin, deps)
  if (grant === 'refresh_token') return refreshGrant(fields, origin, deps)
  return oauthError('unsupported_grant_type', 'Supported grants: authorization_code and refresh_token')
}

const revoke = async (request: Request, deps: OAuthDeps): Promise<Response> => {
  const fields = await readFields(request)
  const tokenValue = fields === undefined ? '' : field(fields, 'token')
  if (fields !== undefined && tokenValue !== '')
    await deps.store.revokeToken(await tokenHash(tokenValue), field(fields, 'client_id'), seconds(deps))
  // RFC 7009 §2.2: an unknown or already revoked token is answered the same.
  return json({}, 200, true)
}

const CONSENT_PATH = /^\/api\/oauth\/requests\/(oauth_[0-9a-f]{40})$/u

/** The routes that need no store, or none at all. */
const metadata = (request: Request, url: URL): Response | undefined => {
  const { pathname } = url
  if (request.method === 'OPTIONS' && (pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/')))
    return new Response(null, { status: 204, headers: PUBLIC })
  if (request.method !== 'GET') return undefined
  if (pathname === '/.well-known/oauth-protected-resource' || pathname === '/.well-known/oauth-protected-resource/mcp')
    return protectedResource(url.origin)
  if (pathname === '/.well-known/oauth-authorization-server') return authorizationServer(url.origin)
  return undefined
}

/** Answers the OAuth paths with the given store, identity verifier and clock; undefined for any other path. */
export async function routeOAuth(request: Request, deps: OAuthDeps): Promise<Response | undefined> {
  const url = new URL(request.url)
  const known = metadata(request, url)
  if (known !== undefined) return known
  const { method } = request
  const { pathname } = url
  if (pathname === '/oauth/register' && method === 'POST') return register(request, deps)
  if (pathname === '/oauth/authorize' && method === 'GET') return authorize(url, deps)
  if (pathname === '/oauth/token' && method === 'POST') return token(request, deps)
  if (pathname === '/oauth/revoke' && method === 'POST') return revoke(request, deps)
  const consentId = CONSENT_PATH.exec(pathname)?.[1]
  if (consentId !== undefined && (method === 'GET' || method === 'POST')) return consent(request, consentId, deps)
  return undefined
}

/** The router's OAuth handler: `routeOAuth` over the `WalletAuth` singleton and the Privy identity verifier. */
export const handleOAuth = (request: Request, env: WalletEnv): Promise<Response | undefined> =>
  routeOAuth(request, oauthDeps(env))
