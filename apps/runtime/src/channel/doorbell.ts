// The Telegram channel's way in (ADR 0008). myagent rings a doorbell at a URL that only this user's agent answers,
// `/hooks/myagent/<userId>/<token>`: the token is an HMAC of the user id under a key derived from the credential key,
// so the Worker checks it before it wakes any agent. The agent then checks myagent's signature, made with the secret
// the agent gave it when it subscribed. A doorbell says only where to read from; the agent pulls the messages itself.
import { constantTimeEqual } from 'better-auth/crypto'

const encoder = new TextEncoder()
/** How far a doorbell's timestamp may be from the agent's clock. */
const SKEW_MS = 5 * 60 * 1000

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
const base64url = (bytes: ArrayBuffer) =>
  btoa(String.fromCodePoint(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')

const hmac = async (key: CryptoKey, data: string) => crypto.subtle.sign('HMAC', key, encoder.encode(data))

/** The hook key: HKDF of the credential key (32 bytes, base64), for this purpose only. */
async function hookKey(credentialKey: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(credentialKey), (char) => char.codePointAt(0) ?? 0)
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode('purrable/channel-hook') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

/** The token of a user's hook URL. */
export const hookToken = async (credentialKey: string, userId: string): Promise<string> =>
  base64url(await hmac(await hookKey(credentialKey), userId))

/** Whether `token` is the user's hook token, compared in constant time. */
export const hookTokenValid = async (credentialKey: string, userId: string, token: string): Promise<boolean> =>
  constantTimeEqual(encoder.encode(await hookToken(credentialKey, userId)), encoder.encode(token))

/** The URL myagent rings for this user. */
export const hookUrl = (appUrl: string, userId: string, token: string): string =>
  `${new URL(appUrl).origin}/hooks/myagent/${encodeURIComponent(userId)}/${token}`

/** A doorbell as myagent sends it: its body and the two headers that sign it. */
export interface Doorbell {
  readonly body: string
  readonly timestamp: string
  readonly signature: string
}

/** Whether myagent signed `doorbell` with `secret` within five minutes of `now` (epoch ms). */
export async function doorbellValid(secret: string, doorbell: Doorbell, now: number): Promise<boolean> {
  const at = Number(doorbell.timestamp)
  if (!Number.isSafeInteger(at) || Math.abs(now - at) > SKEW_MS) return false
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const expected = hex(await hmac(key, `${doorbell.timestamp}.${doorbell.body}`))
  return constantTimeEqual(encoder.encode(expected), encoder.encode(doorbell.signature))
}
