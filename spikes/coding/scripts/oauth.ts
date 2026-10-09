import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, rename, writeFile } from 'node:fs/promises'
import * as Schema from 'effect/Schema'
import { digest } from './overlay.ts'

const Client = Schema.Struct({ client_id: Schema.String, redirect_uris: Schema.Array(Schema.String) })
const Code = Schema.Struct({
  client: Schema.String,
  redirect: Schema.String,
  challenge: Schema.String,
  expires: Schema.Number,
})
const Refresh = Schema.Struct({ client: Schema.String, expires: Schema.Number })
const Store = Schema.Struct({
  clients: Schema.Record(Schema.String, Client),
  codes: Schema.Record(Schema.String, Code),
  tokens: Schema.Record(Schema.String, Schema.Number),
  refresh: Schema.Record(Schema.String, Refresh),
  approvals: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
})
const Registration = Schema.Struct({ redirect_uris: Schema.Array(Schema.String) })
const opaque = (): string => randomBytes(32).toString('base64url')
const response = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } })

/** Single-owner spike auth: real OAuth/PKCE for Goblin, operator-only authorization, hashed credentials on disk. */
export class OAuth {
  private data: typeof Store.Type = { clients: {}, codes: {}, tokens: {}, refresh: {} }
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly origin: string,
    readonly ownerOrigins: readonly string[],
    readonly adminKey: string,
    readonly stateFile: string,
  ) {}

  async restore(): Promise<void> {
    if (await Bun.file(this.stateFile).exists())
      this.data = Schema.decodeUnknownSync(Store)(await Bun.file(this.stateFile).json())
  }

  private async save(): Promise<void> {
    const temporary = `${this.stateFile}.tmp`
    await writeFile(temporary, JSON.stringify(this.data), { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.stateFile)
  }

  admin(request: Request): boolean {
    return timingSafeEqual(
      Buffer.from(digest(request.headers.get('authorization') ?? '')),
      Buffer.from(digest(`Bearer ${this.adminKey}`)),
    )
  }

  allowed(request: Request): boolean {
    const token = request.headers.get('authorization')?.replace(/^Bearer /u, '') ?? ''
    return (this.data.tokens[digest(token)] ?? 0) > Date.now()
  }

  challenge(): Response {
    return new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource", scope="coding"`,
      },
    })
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return response({
        resource: `${this.origin}/mcp`,
        authorization_servers: [this.origin],
        scopes_supported: ['coding'],
      })
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return response({
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['coding'],
      })
    const work = this.dispatch(request, url)
    if (work) {
      const result = this.queue.then(work, work)
      this.queue = result.catch(() => undefined)
      return result
    }
    return undefined
  }

  private dispatch(request: Request, url: URL): (() => Promise<Response>) | undefined {
    if (url.pathname === '/register' && request.method === 'POST') return () => this.register(request)
    if (url.pathname === '/authorize' && ['GET', 'POST'].includes(request.method))
      return () => this.authorize(request, url)
    if (url.pathname === '/operator/approval-code' && request.method === 'POST') return () => this.mint(request)
    if (url.pathname === '/token' && request.method === 'POST') return () => this.token(request)
    return undefined
  }

  private async register(request: Request): Promise<Response> {
    const input = Schema.decodeUnknownSync(Registration)(await request.json())
    const redirect = input.redirect_uris[0] ?? ''
    if (
      input.redirect_uris.length !== 1 ||
      !this.ownerOrigins.some((origin) => redirect === `${origin}/api/mcp/oauth/callback`) ||
      Object.keys(this.data.clients).length >= 20
    )
      return response({ error: 'invalid_client_metadata' }, 400)
    const client = { client_id: opaque(), redirect_uris: [redirect] }
    this.data = { ...this.data, clients: { ...this.data.clients, [client.client_id]: client } }
    await this.save()
    return response(
      {
        ...client,
        client_name: 'goblin',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      201,
    )
  }

  private async authorize(request: Request, url: URL): Promise<Response> {
    const params = url.searchParams
    const client = params.get('client_id') ?? ''
    const redirect = params.get('redirect_uri') ?? ''
    const challenge = params.get('code_challenge') ?? ''
    if (
      !this.data.clients[client]?.redirect_uris.includes(redirect) ||
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      !/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
      params.get('resource') !== `${this.origin}/mcp`
    )
      return response({ error: 'invalid_request' }, 400)
    if (!this.admin(request)) {
      const approval = await this.approve(request)
      if (approval) return approval
    }
    const code = opaque()
    this.data = {
      ...this.data,
      codes: { ...this.data.codes, [digest(code)]: { client, redirect, challenge, expires: Date.now() + 600_000 } },
    }
    await this.save()
    const target = new URL(redirect)
    target.searchParams.set('code', code)
    target.searchParams.set('state', params.get('state') ?? '')
    target.searchParams.set('iss', this.origin)
    return new Response(null, { status: 302, headers: { location: target.href, 'cache-control': 'no-store' } })
  }

  private async mint(request: Request): Promise<Response> {
    if (!this.admin(request)) return response({ error: 'operator_authorization_required' }, 401)
    const code = opaque()
    const expires = Date.now() + 30 * 60_000
    this.data = { ...this.data, approvals: { [digest(code)]: expires } }
    await this.save()
    return response({ code, expires })
  }

  private async approve(request: Request): Promise<Response | undefined> {
    if (request.method === 'GET')
      return new Response(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
          '<title>Approve coding connection</title><h1>Approve coding connection</h1>' +
          '<form method="post"><label>One-time approval code <input name="approval_code" type="password" ' +
          'required autocomplete="off" maxlength="100"></label><button>Connect</button></form></html>',
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            // Not no-referrer: browsers then send `Origin: null` on the form post and the origin check refuses it.
            'referrer-policy': 'same-origin',
            'content-security-policy':
              "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
          },
        },
      )
    if (request.headers.get('origin') !== this.origin) return response({ error: 'invalid_origin' }, 403)
    const form = new URLSearchParams(await request.text())
    const key = digest(form.get('approval_code') ?? '')
    const approvals = this.data.approvals ?? {}
    if ((approvals[key] ?? 0) <= Date.now()) return response({ error: 'invalid_approval_code' }, 403)
    this.data = {
      ...this.data,
      approvals: Object.fromEntries(Object.entries(approvals).filter(([entry]) => entry !== key)),
    }
    return undefined
  }

  private async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text())
    const client = form.get('client_id') ?? ''
    if (form.get('resource') !== `${this.origin}/mcp`) return response({ error: 'invalid_target' }, 400)
    if (form.get('grant_type') === 'authorization_code') {
      const key = digest(form.get('code') ?? '')
      const code = this.data.codes[key]
      const verifier = form.get('code_verifier') ?? ''
      const challenge = Buffer.from(digest(verifier), 'hex').toString('base64url')
      if (
        !code ||
        code.expires <= Date.now() ||
        code.client !== client ||
        code.redirect !== form.get('redirect_uri') ||
        code.challenge !== challenge
      )
        return response({ error: 'invalid_grant' }, 400)
      const codes = Object.fromEntries(Object.entries(this.data.codes).filter(([entryKey]) => entryKey !== key))
      this.data = { ...this.data, codes }
    } else if (form.get('grant_type') === 'refresh_token') {
      const key = digest(form.get('refresh_token') ?? '')
      const saved = this.data.refresh[key]
      if (!saved || saved.expires <= Date.now() || saved.client !== client)
        return response({ error: 'invalid_grant' }, 400)
      const refresh = Object.fromEntries(Object.entries(this.data.refresh).filter(([entryKey]) => entryKey !== key))
      this.data = { ...this.data, refresh }
    } else return response({ error: 'unsupported_grant_type' }, 400)
    const accessToken = opaque()
    const refreshToken = opaque()
    this.data = {
      ...this.data,
      tokens: { ...this.data.tokens, [digest(accessToken)]: Date.now() + 86_400_000 },
      refresh: { ...this.data.refresh, [digest(refreshToken)]: { client, expires: Date.now() + 7 * 86_400_000 } },
    }
    await this.save()
    return response({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 86_400,
      refresh_token: refreshToken,
      scope: 'coding',
    })
  }
}
