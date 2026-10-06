import { InvalidInput, PayloadTooLarge } from '../http/errors.ts'
import { AppCodeError } from './queue.ts'

/** How a fetch reaches the internet (the platform's `fetch`, or a test's stand-in). */
export type Send = (url: URL, init: RequestInit) => Promise<Response>

/** What an app's `prepare` sends with `ctx.fetch`. */
export type EgressRequest = {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
}
/** What it gets back: the status, the final URL, the headers it may read, and the body as text. */
export type EgressResponse = {
  readonly status: number
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/** A `prepare`'s fetches (ADR 0021): how many, how large each way, how long, how many redirects. */
export const EGRESS_LIMITS = {
  requests: 20,
  requestBytes: 1024 * 1024,
  responseBytes: 5 * 1024 * 1024,
  ms: 15_000,
  redirects: 3,
} as const

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
/** Request headers an app may not set: the platform's, and credentials of the owner's browser. */
const BARRED = new Set(['cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'te', 'upgrade'])
/** Response headers an app reads. */
const READABLE = new Set(['content-type', 'content-language', 'etag', 'last-modified', 'location', 'retry-after'])

/** The registrable part of goblin's own host (`goblin.surf` for `dev.goblin.surf`): an app never reaches it. */
const ownDomain = (appUrl: string) => new URL(appUrl).hostname.split('.').slice(-2).join('.')

/** Why `raw` is not a URL this app may fetch, or the URL. */
function checked(raw: string, approved: (host: string) => boolean, own: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppCodeError(`fetch: "${raw.slice(0, 200)}" is not a URL`)
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '')
    throw new AppCodeError(`fetch: only https:// on the default port, without credentials (${url.origin})`)
  const host = url.hostname
  if (host === own || host.endsWith(`.${own}`)) throw new AppCodeError(`fetch: an app does not reach goblin itself`)
  if (!approved(host))
    throw new AppCodeError(
      `fetch: ${host} is not approved. Add it to the app's egress; the owner approves it before it is used.`,
    )
  return url
}

function requestHeaders(headers: Readonly<Record<string, string>> | undefined): Headers {
  const out = new Headers()
  for (const [name, value] of Object.entries(headers ?? {}))
    if (!BARRED.has(name.toLowerCase()) && !name.toLowerCase().startsWith('proxy-')) out.set(name, value)
  return out
}

/** The body as text, refused past `limit` bytes without reading further. */
async function bounded(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new PayloadTooLarge({ limit })
    }
    chunks.push(read.value)
  }
  const whole = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    whole.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(whole)
}

/** A redirect's method and body, as browsers do: 303 always, and 301 or 302 after a POST, become a GET with no body. */
function redirected(status: number, method: string, body: string | undefined) {
  return status === 303 || ((status === 301 || status === 302) && method === 'POST')
    ? { method: 'GET', body: undefined }
    : { method, body }
}

/** What the app sends: a method it may use and a body within the limit. */
function outgoing(init: EgressRequest): { readonly method: string; readonly body: string | undefined } {
  const method = (init.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) throw new InvalidInput({ reason: `fetch: method ${method.slice(0, 10)}` })
  const body = init.body ?? undefined
  if (body !== undefined && new TextEncoder().encode(body).byteLength > EGRESS_LIMITS.requestBytes)
    throw new PayloadTooLarge({ limit: EGRESS_LIMITS.requestBytes })
  return { method, body }
}

/**
 * One fetch for an app's `prepare`: https to an exact approved host, never goblin's own domain, redirects followed by
 * hand and each one checked again, no cookies either way, bounded in size and time. Its failures are the app's.
 */
export async function egress(
  send: Send,
  raw: string,
  init: EgressRequest,
  policy: { readonly approved: (host: string) => boolean; readonly appUrl: string },
): Promise<EgressResponse> {
  let { method, body } = outgoing(init)
  const own = ownDomain(policy.appUrl)
  const signal = AbortSignal.timeout(EGRESS_LIMITS.ms)
  let url = checked(raw, policy.approved, own)
  for (let hop = 0; ; hop += 1) {
    const sent = body === undefined || method === 'GET' || method === 'HEAD' ? {} : { body }
    const response = await send(url, {
      method,
      headers: requestHeaders(init.headers),
      redirect: 'manual',
      signal,
      ...sent,
    })
    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || location === null) {
      const headers = Object.fromEntries([...response.headers].filter(([name]) => READABLE.has(name.toLowerCase())))
      return {
        status: response.status,
        url: url.href,
        headers,
        body: await bounded(response, EGRESS_LIMITS.responseBytes),
      }
    }
    await response.body?.cancel()
    if (hop >= EGRESS_LIMITS.redirects) throw new AppCodeError(`fetch: more than ${EGRESS_LIMITS.redirects} redirects`)
    url = checked(new URL(location, url).href, policy.approved, own)
    ;({ method, body } = redirected(response.status, method, body))
  }
}
