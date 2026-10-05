/** Adapted from myapps@8a69ec64: Standard Webhooks HMAC-SHA256, verified on raw bytes before JSON parsing. */
export interface WebhookHeaders {
  readonly id: string
  readonly timestamp: string
  readonly signature: string
}
const bytes = (base64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
const WEBHOOK_TOLERANCE_S = 300

export async function verifyStandardWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  nowMs: number,
): Promise<boolean> {
  if (!headers.id || headers.id.length > 200 || !/^\d+$/u.test(headers.timestamp) || headers.signature.length > 4096)
    return false
  const timestamp = Number(headers.timestamp)
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs / 1000 - timestamp) > WEBHOOK_TOLERANCE_S) return false
  try {
    const raw = bytes(secret.startsWith('whsec_') ? secret.slice(6) : secret)
    if (raw.length === 0) return false
    const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    const message = new TextEncoder().encode(`${headers.id}.${headers.timestamp}.${body}`)
    let valid = false
    for (const entry of headers.signature.split(' ')) {
      const [version, signature] = entry.split(',')
      if (version !== 'v1' || signature === undefined) continue
      try {
        if (await crypto.subtle.verify('HMAC', key, bytes(signature), message)) valid = true
      } catch {
        /* Malformed signature entries do not match. */
      }
    }
    return valid
  } catch {
    return false
  }
}
