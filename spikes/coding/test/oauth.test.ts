import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { OAuth } from '../scripts/oauth.ts'
import * as Schema from 'effect/Schema'

const redirect = 'https://dev.goblin.surf/api/mcp/oauth/callback'
const resource = 'https://coding.example.test/mcp'
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url')

describe('coding OAuth', () => {
  test('requires operator authorization and consumes PKCE codes once', async () => {
    const state = await mkdtemp(join(tmpdir(), 'goblin-coding-oauth-'))
    const oauth = new OAuth(
      resource.slice(0, -4),
      ['https://dev.goblin.surf', 'https://goblin.surf'],
      'operator-secret',
      join(state, 'oauth.json'),
    )
    const registration = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/register`, {
        method: 'POST',
        body: JSON.stringify({ redirect_uris: [redirect] }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    expect(registration?.status).toBe(201)
    const client = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(await registration!.json())
    const verifier = 'a'.repeat(43)
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirect,
      response_type: 'code',
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
      resource,
      state: 'state-1',
    })
    const refused = await oauth.handle(new Request(`${resource.slice(0, -4)}/authorize?${query.toString()}`))
    expect(refused?.status).toBe(200)
    expect(await refused?.text()).toContain('One-time approval code')
    const approved = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/authorize?${query.toString()}`, {
        headers: { authorization: 'Bearer operator-secret' },
      }),
    )
    expect(approved?.status).toBe(302)
    const location = new URL(approved!.headers.get('location')!)
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code: location.searchParams.get('code')!,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource,
    })
    const token = await oauth.handle(new Request(`${resource.slice(0, -4)}/token`, { method: 'POST', body: tokenBody }))
    expect(token?.status).toBe(200)
    const replay = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/token`, { method: 'POST', body: tokenBody }),
    )
    expect(replay?.status).toBe(400)
  })

  test('accepts either owner callback and rejects wrong, expired and reused approvals', async () => {
    const state = await mkdtemp(join(tmpdir(), 'goblin-coding-oauth-'))
    const oauth = new OAuth(
      resource.slice(0, -4),
      ['https://dev.goblin.surf', 'https://goblin.surf'],
      'operator-secret',
      join(state, 'oauth.json'),
    )
    const registration = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/register`, {
        method: 'POST',
        body: JSON.stringify({ redirect_uris: ['https://goblin.surf/api/mcp/oauth/callback'] }),
      }),
    )
    expect(registration?.status).toBe(201)
    const client = Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(await registration!.json())
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://goblin.surf/api/mcp/oauth/callback',
      response_type: 'code',
      code_challenge: challenge('b'.repeat(43)),
      code_challenge_method: 'S256',
      resource,
    })
    const wrong = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/authorize?${query.toString()}`, {
        method: 'POST',
        headers: { origin: resource.slice(0, -4), 'content-type': 'application/x-www-form-urlencoded' },
        body: 'approval_code=wrong',
      }),
    )
    expect(wrong?.status).toBe(403)
    const minted = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/operator/approval-code`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    )
    const approval = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(await minted!.json()).code
    const persisted = await Bun.file(join(state, 'oauth.json')).text()
    expect(persisted).not.toContain(approval)
    const saved = Schema.decodeUnknownSync(Schema.Struct({ approvals: Schema.Record(Schema.String, Schema.Number) }))(
      JSON.parse(persisted),
    )
    const expiry = saved.approvals[createHash('sha256').update(approval).digest('hex')]!
    expect(expiry - Date.now()).toBeGreaterThan(29 * 60_000)
    expect(expiry - Date.now()).toBeLessThanOrEqual(30 * 60_000)
    await oauth.restore()
    const approved = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/authorize?${query.toString()}`, {
        method: 'POST',
        headers: { origin: resource.slice(0, -4), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ approval_code: approval }),
      }),
    )
    expect(approved?.status).toBe(302)
    const reused = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/authorize?${query.toString()}`, {
        method: 'POST',
        headers: { origin: resource.slice(0, -4), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ approval_code: approval }),
      }),
    )
    expect(reused?.status).toBe(403)
    const expired = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/operator/approval-code`, {
        method: 'POST',
        headers: { authorization: 'Bearer operator-secret' },
      }),
    )
    const expiredCode = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }))(await expired!.json()).code
    const data = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      await Bun.file(join(state, 'oauth.json')).json(),
    )
    const key = createHash('sha256').update(expiredCode).digest('hex')
    await Bun.write(join(state, 'oauth.json'), JSON.stringify({ ...data, approvals: { [key]: Date.now() - 1 } }))
    await oauth.restore()
    const rejected = await oauth.handle(
      new Request(`${resource.slice(0, -4)}/authorize?${query.toString()}`, {
        method: 'POST',
        headers: { origin: resource.slice(0, -4), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ approval_code: expiredCode }),
      }),
    )
    expect(rejected?.status).toBe(403)
  })
})
