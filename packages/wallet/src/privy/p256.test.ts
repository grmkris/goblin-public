import { describe, expect, test } from 'vitest'
import { formatAuthorizationPayload } from './client.ts'
import { generateAuthorizationKey, verifiesDer } from './fixtures.ts'
import { authorizationSigner, p1363ToDer } from './p256.ts'

/** A throwaway P-256 key made for this test only (never a Privy key quorum's). */
const FIXTURE_KEY = {
  pkcs8:
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaVuQw4A9hmpI2acJ8GE/H5mjQh+Mjb/ZJGxAACDaG52hRANCAAQNXgHgaokQGprI7OMmCsa9mdy5LZkccxJ3ts+HuSjZJnTjaN25moElaRFGkW+XZ0shxWoq7jj+3rIVmifggG5j',
  spki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEDV4B4GqJEBqayOzjJgrGvZncuS2ZHHMSd7bPh7ko2SZ042jduZqBJWkRRpFvl2dLIcVqKu44/t6yFZon4IBuYw==',
}

const bytes = (hexString: string) => Uint8Array.from(hexString.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16))
const hexOf = (value: Uint8Array) => Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')

describe('Privy P-256 authorization signatures', () => {
  test('P1363 → DER known answers: high-bit padding and leading-zero trimming', () => {
    const r = `80${'11'.repeat(31)}`
    const s = `0000${'7f'.repeat(30)}`
    expect(hexOf(p1363ToDer(bytes(r + s)))).toBe(`3043022100${r}021e${'7f'.repeat(30)}`)
    const small = `${'00'.repeat(31)}01${'00'.repeat(31)}02`
    expect(hexOf(p1363ToDer(bytes(small)))).toBe('3006020101020102')
    expect(() => p1363ToDer(new Uint8Array(63))).toThrow('invalid_signature')
  })

  test('the fixture key signs payloads verify as strict DER, with or without the wallet-auth prefix', async () => {
    const payload = formatAuthorizationPayload({
      method: 'post',
      url: 'https://api.privy.io/v1/wallets/w1/rpc',
      body: { params: { b: 1, a: [true, null] }, method: 'eth_signTypedData_v4' },
      headers: { 'privy-app-id': 'app', 'privy-idempotency-key': 'op-1' },
    })
    for (const key of [FIXTURE_KEY.pkcs8, `wallet-auth:${FIXTURE_KEY.pkcs8}`]) {
      const signature = await (await authorizationSigner(key))(payload)
      expect(await verifiesDer(FIXTURE_KEY.spki, payload, signature)).toBe(true)
      expect(await verifiesDer(FIXTURE_KEY.spki, `${payload} `, signature)).toBe(false)
    }
  })

  test('the authorization payload is RFC 8785 JSON of version, method, url, body and privy headers', () => {
    expect(
      formatAuthorizationPayload({
        method: 'patch',
        url: 'https://api.privy.io/v1/policies/p1',
        body: { rules: [{ name: 'x', conditions: [] }], name: 'n' },
        headers: { 'privy-request-expiry': '1700000060000', 'privy-app-id': 'app' },
      }),
    ).toBe(
      '{"body":{"name":"n","rules":[{"conditions":[],"name":"x"}]},"headers":{"privy-app-id":"app","privy-request-expiry":"1700000060000"},"method":"PATCH","url":"https://api.privy.io/v1/policies/p1","version":1}',
    )
  })

  test('a generated key pair signs and verifies', async () => {
    const pair = await generateAuthorizationKey()
    const signature = await (await authorizationSigner(pair.privateKey))('hello')
    expect(await verifiesDer(pair.publicKey, 'hello', signature)).toBe(true)
  })
})
