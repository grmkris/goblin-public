import { constantTimeEqual } from 'better-auth/crypto'
const encoder = new TextEncoder()
/** Purpose-separated token; checked before the Worker looks up this user's object. */
export async function eventsHookToken(credentialKey: string, userId: string): Promise<string> {
  const base = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(credentialKey), (c) => c.codePointAt(0) ?? 0),
    'HKDF',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(), info: encoder.encode('purrable/mcp-events-hook') },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(userId))
  return btoa(String.fromCodePoint(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}
export async function eventsHookTokenValid(credentialKey: string, userId: string, token: string): Promise<boolean> {
  return constantTimeEqual(encoder.encode(await eventsHookToken(credentialKey, userId)), encoder.encode(token))
}
export const eventsHookUrl = (appUrl: string, userId: string, token: string): string =>
  `${new URL(appUrl).origin}/hooks/mcp-events/${encodeURIComponent(userId)}/${token}`
