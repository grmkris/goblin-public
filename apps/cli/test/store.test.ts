import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CliAuthProvider } from '../src/oauth.ts'
import { CredentialStore } from '../src/store.ts'

const KEY = 'https://goblin.test/mcp/inspect'
const REDIRECT = 'http://127.0.0.1:18979/callback'
const fresh = async () =>
  new CredentialStore(join(await mkdtemp(join(tmpdir(), 'goblin-cli-')), 'goblin', 'credentials.json'))

describe('goblin credentials (unit)', () => {
  it('keeps them in a file only its owner can read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goblin-cli-'))
    const path = join(dir, 'goblin', 'credentials.json')
    const store = new CredentialStore(path)
    await store.update(KEY, { tokens: { access_token: 'a', token_type: 'Bearer' } })
    await store.update(KEY, { redirectUri: REDIRECT })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(dir, 'goblin'))).mode & 0o777).toBe(0o700)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      [KEY]: { tokens: { access_token: 'a', token_type: 'Bearer' }, redirectUri: REDIRECT },
    })
    await store.forget(KEY, ['tokens'])
    expect(await store.read(KEY)).toEqual({ redirectUri: REDIRECT })
    await store.remove(KEY)
    expect(await store.read(KEY)).toEqual({})
  })

  it('gives the SDK only a client registered for this redirect, and well-formed tokens', async () => {
    const store = await fresh()
    const provider = new CliAuthProvider(store, KEY, REDIRECT, 'goblin:inspect offline_access', () => undefined)
    expect(await provider.clientInformation()).toBeUndefined()
    await provider.saveClientInformation({ client_id: 'cli-1', redirect_uris: [REDIRECT] })
    expect(await provider.clientInformation()).toEqual({ client_id: 'cli-1' })
    const elsewhere = new CliAuthProvider(store, KEY, 'http://127.0.0.1:18980/callback', '', () => undefined)
    expect(await elsewhere.clientInformation()).toBeUndefined()
    await store.update(KEY, { tokens: { token_type: 'Bearer' } })
    expect(await provider.tokens()).toBeUndefined()
    await provider.saveTokens({ access_token: 't', token_type: 'Bearer', refresh_token: 'r' })
    expect(await provider.tokens()).toEqual({ access_token: 't', token_type: 'Bearer', refresh_token: 'r' })
    await provider.invalidateCredentials('client')
    expect(await store.read(KEY)).toEqual({ redirectUri: REDIRECT })
    expect(provider.clientMetadata).toMatchObject({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      scope: 'goblin:inspect offline_access',
    })
  })
})
