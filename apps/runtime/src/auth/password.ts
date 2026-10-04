import { constantTimeEqual } from 'better-auth/crypto'

const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(''))
const decode = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (value) => value.charCodeAt(0))
const derive = async (
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256))
}
/** Adapted from MyApps WebCrypto PBKDF2 policy; avoids CPU-heavy synchronous scrypt in Workers. */
export const passwordHasher = {
  async hash(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16))
    return `pbkdf2-sha256$100000$${encode(salt)}$${encode(await derive(password, salt, 100_000))}`
  },
  async verify(input: { hash: string; password: string }): Promise<boolean> {
    const parts = input.hash.split('$')
    const [prefix, count, salt, expected] = parts
    const iterations = Number(count)
    if (
      parts.length !== 4 ||
      prefix !== 'pbkdf2-sha256' ||
      !salt ||
      !expected ||
      !Number.isSafeInteger(iterations) ||
      iterations < 100_000 ||
      iterations > 1_000_000
    )
      return false
    try {
      const saltBytes = decode(salt)
      const expectedBytes = decode(expected)
      if (saltBytes.byteLength !== 16 || expectedBytes.byteLength !== 32) return false
      return constantTimeEqual(encode(await derive(input.password, saltBytes, iterations)), encode(expectedBytes))
    } catch {
      return false
    }
  },
}
