import { Internal } from '../http/errors.ts'

const VERSION = 'v1'
const encode = (bytes: Uint8Array): string => btoa(Array.from(bytes, (value) => String.fromCharCode(value)).join(''))
const decode = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (value) => value.charCodeAt(0))

/**
 * AES-256-GCM for credentials at rest. The additional data binds each ciphertext to its row and purpose
 * (`<serverId>:<kind>`), so a value copied to another server or column fails to decrypt.
 */
export class CredentialCipher {
  readonly #key: CryptoKey
  private constructor(key: CryptoKey) {
    this.#key = key
  }

  /** `secret` is 32 random bytes, base64-encoded (`openssl rand -base64 32`). */
  static async fromBase64(secret: string): Promise<CredentialCipher> {
    let raw: Uint8Array<ArrayBuffer>
    try {
      raw = decode(secret.trim())
    } catch {
      throw new Internal({ reason: 'credential key is not base64' })
    }
    if (raw.byteLength !== 32) throw new Internal({ reason: 'credential key must be 32 bytes' })
    return new CredentialCipher(await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']))
  }

  async encrypt(plaintext: string, aad: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = new TextEncoder().encode(plaintext)
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
      this.#key,
      data,
    )
    return `${VERSION}:${encode(iv)}:${encode(new Uint8Array(sealed))}`
  }

  async decrypt(value: string, aad: string): Promise<string> {
    const [version, iv, sealed] = value.split(':')
    if (version !== VERSION || iv === undefined || sealed === undefined)
      throw new Internal({ reason: 'credential ciphertext format' })
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(iv), additionalData: new TextEncoder().encode(aad) },
        this.#key,
        decode(sealed),
      )
      return new TextDecoder().decode(plain)
    } catch {
      throw new Internal({ reason: 'credential could not be decrypted' })
    }
  }
}
