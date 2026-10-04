import { describe, expect, it } from 'vitest'
import { CredentialCipher } from '../../src/mcp/cipher.ts'

const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))

describe('credential cipher (unit)', () => {
  it('round-trips and never stores the plaintext', async () => {
    const cipher = await CredentialCipher.fromBase64(key)
    const sealed = await cipher.encrypt('{"access_token":"secret-token"}', 'myplan:tokens')
    expect(sealed).toMatch(/^v1:/u)
    expect(sealed).not.toContain('secret-token')
    expect(await cipher.decrypt(sealed, 'myplan:tokens')).toBe('{"access_token":"secret-token"}')
  })
  it('rejects tampering, another row or purpose, and a wrong key', async () => {
    const cipher = await CredentialCipher.fromBase64(key)
    const sealed = await cipher.encrypt('value', 'myplan:tokens')
    const tampered = `${sealed.slice(0, -4)}AAAA`
    await expect(cipher.decrypt(tampered, 'myplan:tokens')).rejects.toMatchObject({ _tag: 'Internal' })
    await expect(cipher.decrypt(sealed, 'mybrowser:tokens')).rejects.toMatchObject({ _tag: 'Internal' })
    await expect(cipher.decrypt(sealed, 'myplan:client')).rejects.toMatchObject({ _tag: 'Internal' })
    const other = await CredentialCipher.fromBase64(btoa(String.fromCharCode(...new Uint8Array(32))))
    await expect(other.decrypt(sealed, 'myplan:tokens')).rejects.toMatchObject({ _tag: 'Internal' })
  })
  it('refuses a key that is not 32 bytes', async () => {
    await expect(CredentialCipher.fromBase64(btoa('short'))).rejects.toMatchObject({ _tag: 'Internal' })
  })
})
