import { AccountApi, PayloadTooLarge } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as HttpRouter from 'effect/http/HttpRouter'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { readBytes } from '../body.ts'
import { requestFacts, routeNames } from './context.ts'
import { answer, refusal } from './render.ts'

/**
 * The Worker side of the typed API (not wired yet: the switch lands it in `worker.ts`). The Worker keeps the session,
 * origin, CSRF and fresh plan checks, answers the account API itself and forwards every other `/api/*` request to the
 * owner's own agent.
 */

/** What the agent receives besides method, path and body. Cookies and authorization stay at the edge. */
const FORWARDED = [
  'content-type',
  'content-length',
  'accept',
  'last-event-id',
  'x-goblin-request',
  'x-goblin-operation',
] as const
/** The JSON body bound of `http/body.ts`; file uploads stream through to the agent's own limits. */
const JSON_BODY_LIMIT = 65_536
const FILES = '/api/files'

/** The edge's reference for a request: Cloudflare's ray id, or a random one where there is none (a local run). */
export const refOf = (request: Request): string =>
  request.headers.get('cf-ray') ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16)

/** The forwarded body: none, a file upload's stream, or a JSON body read up to its bound. */
async function forwardedBody(request: Request, path: string): Promise<BodyInit | null> {
  if (request.body === null) return null
  if (path === FILES || path.startsWith(`${FILES}/`)) return request.body
  return readBytes(request, JSON_BODY_LIMIT)
}

/**
 * The request the Worker forwards to the owner's agent once it has admitted it, with the edge's reference
 * (`x-goblin-ref`) the agent quotes in its logs and failures. A JSON body over 64 KB is refused here, as `readJson`
 * refused it before.
 */
export async function ownerForward(
  request: Request,
  agent: { readonly fetch: (request: Request) => Promise<Response> },
): Promise<Response> {
  const ref = refOf(request)
  const url = new URL(request.url)
  const headers = new Headers({ 'x-goblin-ref': ref })
  for (const name of FORWARDED) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }
  let body: BodyInit | null
  try {
    body = await forwardedBody(request, url.pathname)
  } catch (error) {
    if (error instanceof PayloadTooLarge) return refusal(error, ref)
    throw error
  }
  // A streamed body needs `duplex` outside workerd (Node, the unit tests); workerd ignores it and its types omit it.
  const init = { method: request.method, headers, body, duplex: 'half' }
  return agent.fetch(new Request(`https://agent${url.pathname}${url.search}`, init))
}

const BillingHandlers = HttpApiBuilder.group(AccountApi, 'billing', (handlers) => handlers)
const ClientsHandlers = HttpApiBuilder.group(AccountApi, 'clients', (handlers) => handlers)
const ClientErrorsHandlers = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) => handlers)
const AccountApiLayer = HttpApiBuilder.layer(AccountApi).pipe(
  Layer.provide([BillingHandlers, ClientsHandlers, ClientErrorsHandlers]),
  Layer.provide(HttpServer.layerServices),
)

/**
 * The account API's handler, built once per isolate: its router lives for the isolate, in a scope that is never
 * closed. `None` for any path that is not one of its endpoints. Its groups are empty until billing, inbound clients and
 * client error reports move here.
 */
export const makeAccountHttp = Effect.gen(function* () {
  const http = yield* HttpRouter.toHttpEffect(AccountApiLayer).pipe(Scope.provide(Scope.makeUnsafe()))
  const routeOf = routeNames(AccountApi)
  return (request: Request): Effect.Effect<Option.Option<Response>> => {
    const route = routeOf(request)
    if (route === undefined) return Effect.succeedNone
    const facts = { ...requestFacts(request, route), ref: refOf(request) }
    return Effect.map(answer(http, request, facts), Option.some)
  }
})
