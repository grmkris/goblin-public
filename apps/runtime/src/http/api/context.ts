import * as Context from 'effect/Context'
import * as FindMyWay from 'effect/http/FindMyWay'
import * as HttpApi from 'effect/http-api/HttpApi'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'

/** What one owner API request says about itself, for logs and error references. Never content. */
export interface RequestFacts {
  /** The Worker edge's reference for the request (its cf-ray), quoted in every failure the agent answers. */
  readonly ref: string | undefined
  /** The browser's own id for the request. */
  readonly request: string | undefined
  /** The operation a write carries, so its logs join the operation's receipt. */
  readonly operation: string | undefined
  /** The endpoint the request reached, as `<group>.<endpoint>` (`topics.update`). */
  readonly route: string
}

/**
 * The current request's facts. The server provides it to each request it answers; handlers and middleware read it with
 * `Effect.serviceOption`, so code that runs outside a request (a test, a probe) still runs without it.
 */
export class RequestContext extends Context.Service<RequestContext, RequestFacts>()('goblin/http/RequestContext') {}

/** cf-ray (`8c1f…-AMS`) or the edge's random fallback. */
const REF = /^[0-9A-Za-z-]{1,64}$/u
/** The browser's short request id. */
const REQUEST = /^[0-9A-Za-z_-]{1,64}$/u
/** Operation ids the web and clients choose (`OperationId` allows more; anything else is left out of logs). */
const OPERATION = /^[0-9A-Za-z_.:-]{1,128}$/u

/** A header's value when it is short and plain; anything else counts as absent. */
const header = (request: Request, name: string, pattern: RegExp): string | undefined => {
  const value = request.headers.get(name)
  return value !== null && pattern.test(value) ? value : undefined
}

/** The reference the Worker edge forwarded with `request`, when it is one. */
export const forwardedRef = (request: Request): string | undefined => header(request, 'x-goblin-ref', REF)

/** The facts the Worker edge forwarded with `request`, which reached `route`. */
export const requestFacts = (request: Request, route: string): RequestFacts => ({
  ref: forwardedRef(request),
  request: header(request, 'x-goblin-request', REQUEST),
  operation: header(request, 'x-goblin-operation', OPERATION),
  route,
})

/**
 * The route a log line names for a path that is not an API endpoint: its area (`/api/conversations/{path}`), never
 * the ids or names below it, which the owner chose.
 */
export const routeTemplate = (path: string): string => {
  const [, root = '', area, ...rest] = path.split('/')
  return area === undefined ? path : `/${root}/${area}${rest.length === 0 ? '' : '/{path}'}`
}

/** HttpApi paths are absolute; the guard only tells the router so. */
const isPath = (path: string): path is FindMyWay.PathInput => path.startsWith('/')

/** The endpoint a request names (`topics.update`), if it names one of an API's. */
export type RouteNames = (request: Request) => string | undefined

/**
 * The name of each of `api`'s endpoints (`topics.update`) by method and path: whether a request is the API's at all is
 * known before anything runs, and its logs name the endpoint rather than a path that may carry ids.
 */
export const routeNames = <Id extends string, Groups extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, Groups>,
): RouteNames => {
  const router = FindMyWay.make<string>()
  HttpApi.reflect(api, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => {
      if (isPath(endpoint.path)) router.on(endpoint.method, endpoint.path, `${group.identifier}.${endpoint.identifier}`)
    },
  })
  return (request) => router.find(request.method, new URL(request.url).pathname)?.handler
}
