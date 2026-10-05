import * as Schema from 'effect/Schema'
import * as Option from 'effect/Option'
import { constantTimeEqual } from 'better-auth/crypto'
import { InvalidInput } from '../../http/errors.ts'
import { EventControl, EventOccurrence, type EventEnvelope } from './protocol.ts'

export const EVENT_BODY_BYTES = 262_144
const EVENT_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000
const text = new TextEncoder()
const b64 = (bytes: ArrayBuffer) => btoa(String.fromCodePoint(...new Uint8Array(bytes)))
const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.codePointAt(0) ?? 0)
const rawSecret = (secret: string): Uint8Array<ArrayBuffer> => {
  if (!secret.startsWith('whsec_')) throw new InvalidInput({ reason: 'event secret prefix' })
  try {
    const bytes = unb64(secret.slice(6))
    if (bytes.byteLength < 24 || bytes.byteLength > 64) throw new Error('length')
    return bytes
  } catch {
    throw new InvalidInput({ reason: 'event secret encoding' })
  }
}

export async function sign(secret: string, webhookId: string, timestamp: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('raw', rawSecret(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return `v1,${b64(await crypto.subtle.sign('HMAC', key, new Uint8Array([...text.encode(`${webhookId}.${timestamp}.`), ...body])))}`
}

export type WebhookHeaders = { readonly id: string; readonly timestamp: string; readonly signature: string }
export async function verifyWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: Uint8Array,
  now: number,
): Promise<void> {
  if (body.byteLength > EVENT_BODY_BYTES) throw new InvalidInput({ reason: 'event body too large' })
  const timestamp = Number(headers.timestamp)
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp * 1000) > EVENT_TIMESTAMP_WINDOW_MS)
    throw new InvalidInput({ reason: 'event timestamp' })
  const signatures = headers.signature
    .split(' ')
    .map((part) => part.split(',', 2))
    .filter(([version, value]) => version === 'v1' && value !== undefined)
  const expected = await sign(secret, headers.id, headers.timestamp, body)
  if (!signatures.some(([, value]) => constantTimeEqual(text.encode(`v1,${value}`), text.encode(expected))))
    throw new InvalidInput({ reason: 'event signature' })
}

export function decodeEnvelope(body: Uint8Array, webhookId: string): EventEnvelope {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new InvalidInput({ reason: 'event body JSON' })
  }
  if (typeof value === 'object' && value !== null && 'type' in value) {
    const control = Schema.decodeUnknownOption(EventControl)(value)
    if (Option.isNone(control)) throw new InvalidInput({ reason: 'event control shape' })
    return control.value
  }
  const occurrence = Schema.decodeUnknownOption(EventOccurrence)(value)
  if (Option.isNone(occurrence) || occurrence.value.eventId !== webhookId)
    throw new InvalidInput({ reason: 'event id mismatch' })
  return occurrence.value
}

export function isOccurrence(value: EventEnvelope): value is typeof EventOccurrence.Type {
  return 'eventId' in value
}
export function challengeResponse(value: EventEnvelope): string | undefined {
  return 'type' in value && value.type === 'verification' ? JSON.stringify({ challenge: value.challenge }) : undefined
}
