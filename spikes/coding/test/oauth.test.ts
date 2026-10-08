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
      'https://dev.goblin.surf',
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
    expect(refused?.status).toBe(401)
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
})
