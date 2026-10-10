// The dev smoke's check of the typed API's edge, apart from smoke-dev.ts, which runs on import.
import { Schema } from 'effect'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Step } from './smoke-client.ts'

const object = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

/** The owner's requests to the deployed stage; `csrf: false` leaves out the header every write otherwise carries. */
type Owner = {
  readonly send: (path: string, init?: RequestInit & { readonly csrf?: boolean }) => Promise<Response>
}

/** A failure's envelope detail (`{ error: { code, message, ref?, … } }`). */
const detailOf = async (response: Response) => object(object(await response.json())['error'])

/**
 * The typed API's edge: a failure answers in the error envelope, quoting the reference the response carries in
 * `x-goblin-ref`, and a write without the CSRF header is refused before it reaches the agent.
 */
export async function edgeChecks(
  dev: Owner,
): Promise<{ readonly edge: { readonly envelope: 'ok'; readonly csrf: 'refused' } }> {
  const missing = await dev.send('/api/conversations/999999999999/snapshot')
  const ref = missing.headers.get('x-goblin-ref')
  const absent = await detailOf(missing)
  if (missing.status !== 404 || absent['code'] !== 'not_found' || ref === null || absent['ref'] !== ref)
    throw new Error('edge_envelope_missing')
  const forged = await dev.send('/api/topics', {
    method: 'POST',
    csrf: false,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  if (forged.status !== 403 || (await detailOf(forged))['code'] !== 'forbidden')
    throw new Error('edge_csrf_not_refused')
  return { edge: { envelope: 'ok', csrf: 'refused' } }
}

/** A GET of `path` exactly as written, without a session. `fetch` would resolve `..` and `%2e%2e` before sending. */
const rawGet = (origin: string, path: string) =>
  new Promise<{ readonly status: number; readonly body: string }>((resolve, reject) => {
    const url = new URL(origin)
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest
    const port = url.port === '' ? {} : { port: url.port }
    const request = send({ hostname: url.hostname, ...port, path, method: 'GET' }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.setTimeout(30_000, () => request.destroy(new Error('internal_probe_timeout')))
    request.on('error', reject)
    request.end()
  })

/** The agent's internal API from outside: `/internal/*`, and a path that climbs into it, answer the 404 envelope. */
export async function internalChecks(origin: string, steps: Step[]): Promise<{ readonly internal: 'refused' }> {
  for (const path of ['/internal/recent', '/api/%2e%2e/internal/recent']) {
    const { status, body } = await rawGet(origin, path)
    steps.push({ step: `GET ${path} (outside)`, status })
    const code = status === 404 ? object(object(JSON.parse(body))['error'])['code'] : undefined
    if (code !== 'not_found') throw new Error('internal_route_reachable')
  }
  return { internal: 'refused' }
}
