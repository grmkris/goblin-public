// The dev smoke's check of the typed API's edge, apart from smoke-dev.ts, which runs on import.
import { Schema } from 'effect'

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
