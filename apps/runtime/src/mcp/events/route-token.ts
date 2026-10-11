import { constantTimeEqual } from 'better-auth/crypto'
const encoder = new TextEncoder()
/**
 * The route token of one connection's Events webhook (ADR 0041): purpose-separated from the credential key, bound to
 * the user and the connection, and checked before the Worker looks up this user's object.
 */
export async function eventsHookToken(credentialKey: string, userId: string, connectionId: string): Promise<string> {
  const base = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(atob(credentialKey), (c) => c.codePointAt(0) ?? 0),
    'HKDF',
    false,
    ['deriveKey'],
  )
  const key = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(),
      info: encoder.encode('goblin/mcp-events-hook/connection'),
    },
    base,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(`${userId}\n${connectionId}`))
  return btoa(String.fromCodePoint(...new Uint8Array(bytes)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}
export async function eventsHookTokenValid(
  credentialKey: string,
  userId: string,
  connectionId: string,
  token: string,
): Promise<boolean> {
  const expected = await eventsHookToken(credentialKey, userId, connectionId)
  return constantTimeEqual(encoder.encode(expected), encoder.encode(token))
}
/** Where a connection's producer posts its Events: one URL per connection, so subscriptions never collide. */
export const eventsHookUrl = (appUrl: string, userId: string, connectionId: string, token: string): string =>
  `${new URL(appUrl).origin}/hooks/mcp-events/${encodeURIComponent(userId)}/${encodeURIComponent(connectionId)}/${token}`
