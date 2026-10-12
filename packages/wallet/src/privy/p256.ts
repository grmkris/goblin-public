/**
 * Privy authorization signatures with WebCrypto, ported from Sidequest's `packages/sdk/src/p256.ts`: a P-256 key in
 * PKCS#8 (base64, optionally `wallet-auth:`-prefixed, as Privy's dashboard exports it) signs the request's canonical
 * payload; WebCrypto yields IEEE P1363 (r‖s) and Privy wants DER, base64.
 */

/** One DER INTEGER: leading zeros trimmed, a zero byte added when the high bit would make it negative. */
const derInteger = (bytes: Uint8Array): Uint8Array => {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start++
  const value = bytes.slice(start)
  const pad = ((value[0] ?? 0) & 0x80) === 0 ? 0 : 1
  const out = new Uint8Array(2 + pad + value.length)
  out.set([0x02, pad + value.length])
  out.set(value, 2 + pad)
  return out
}

/** A 64-byte P1363 signature (r‖s) as a DER `SEQUENCE { INTEGER r, INTEGER s }`. */
export const p1363ToDer = (signature: Uint8Array): Uint8Array => {
  if (signature.length !== 64) throw new Error('invalid_signature: expected a 64-byte P-256 P1363 signature')
  const r = derInteger(signature.slice(0, 32))
  const s = derInteger(signature.slice(32))
  const out = new Uint8Array(2 + r.length + s.length)
  out.set([0x30, r.length + s.length])
  out.set(r, 2)
  out.set(s, 2 + r.length)
  return out
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes))
const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

/** Signs one payload; resolves with the base64 DER signature for `privy-authorization-signature`. */
export type AuthorizationSigner = (payload: string) => Promise<string>

/** An authorization signer over a PKCS#8 P-256 private key. The key never leaves the returned closure. */
export const authorizationSigner = async (pkcs8: string): Promise<AuthorizationSigner> => {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    fromBase64(pkcs8.trim().replace(/^wallet-auth:/u, '')),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  return async (payload) => {
    const raw = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payload))
    return toBase64(p1363ToDer(new Uint8Array(raw)))
  }
}
