/** Test helpers: a strict DER reader and a WebCrypto verifier, independent of the code under test. */

/** Reads a DER `SEQUENCE { INTEGER r, INTEGER s }` back into P1363, strictly, without the code under test. */
export const derToP1363 = (der: Uint8Array): Uint8Array<ArrayBuffer> => {
  const integer = (at: number): { value: Uint8Array; next: number } => {
    if (der[at] !== 0x02) throw new Error('not a DER INTEGER')
    const length = der[at + 1] ?? 0
    const value = der.slice(at + 2, at + 2 + length)
    if (value.length > 33 || (value.length > 1 && value[0] === 0 && ((value[1] ?? 0) & 0x80) === 0))
      throw new Error('non-minimal DER INTEGER')
    return { value: value.slice(-32), next: at + 2 + length }
  }
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new Error('not a DER SEQUENCE')
  const r = integer(2)
  const s = integer(r.next)
  if (s.next !== der.length) throw new Error('trailing DER bytes')
  const out = new Uint8Array(64)
  out.set(r.value, 32 - r.value.length)
  out.set(s.value, 64 - s.value.length)
  return out
}

const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0))

/** Verifies a base64 DER signature under a base64 SPKI key with WebCrypto. */
export const verifiesDer = async (spki: string, payload: string, signatureBase64: string): Promise<boolean> => {
  const key = await crypto.subtle.importKey('spki', fromBase64(spki), { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'verify',
  ])
  const signature = derToP1363(fromBase64(signatureBase64))
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, new TextEncoder().encode(payload))
}

/** A fresh key pair: PKCS#8 private and SPKI public, base64 (the public half is what a Privy key quorum holds). */
export const generateAuthorizationKey = async (): Promise<{ privateKey: string; publicKey: string }> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  return {
    privateKey: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)))),
    publicKey: btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))),
  }
}
