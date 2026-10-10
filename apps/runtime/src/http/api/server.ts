import { NotFound, OwnerApi } from '@goblin/contracts/api'
import { FORWARDED_HEADER, INTERNAL_PREFIX, InternalApi } from '@goblin/contracts/internal'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import type * as Scope from 'effect/Scope'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import type * as HttpServerResponse from 'effect/http/HttpServerResponse'
import { RequestContext, type RouteNames, forwardedRef, requestFacts, routeNames } from './context.ts'
import { AgentApiLayer } from './groups.ts'
import { answer, refusal } from './render.ts'

/** Whether `path` is `prefix` or under it. */
const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)

/**
 * The agent's typed APIs served inside it (ADR 0038): the owner's (`/api`) and the internal one the Worker calls
 * (`/internal`), on one router built once, in the agent's own runtime and the layer's scope, never at module level.
 * `handle` answers every request: an endpoint of either API, or the 404 envelope for any other path and for an
 * internal path forwarded for the owner (it carries the edge's `x-goblin-forwarded`). A streamed answer (server-sent
 * events, a download) owns its body: it outlives the request's scope.
 */
export class AgentHttp extends Context.Service<
  AgentHttp,
  { readonly handle: (request: Request) => Effect.Effect<Response> }
>()('goblin/http/AgentHttp') {
  /**
   * Serves the APIs `routes` names (`routeNames` of each) through `apiLayer`, their groups' handlers behind each API's
   * gate. The agent serves every group of both; a test serves one area's groups with only the services that area needs
   * (`test/http/api/fixture.ts`).
   */
  static serve<R>(routes: readonly RouteNames[], apiLayer: Layer.Layer<never, never, R>) {
    return Layer.effect(
      AgentHttp,
      Effect.gen(function* () {
        const services = yield* Effect.context<HttpRouter.Request.Only<'Requires', R>>()
        const http = yield* HttpRouter.toHttpEffect(apiLayer)
        const routeOf = (request: Request) => {
          for (const route of routes) {
            const name = route(request)
            if (name !== undefined) return name
          }
          return undefined
        }
        return AgentHttp.of({
          handle: (request) => {
            const internal = under(new URL(request.url).pathname, INTERNAL_PREFIX)
            const route = internal && request.headers.has(FORWARDED_HEADER) ? undefined : routeOf(request)
            if (route === undefined)
              return Effect.succeed(refusal(new NotFound({ what: 'route' }), forwardedRef(request)))
            const facts = requestFacts(request, route)
            // SAFETY: `services` is this layer's context, which holds every service the router's handlers require
            // (`R`'s `Requires`), and neither API declares a global middleware: what is left is the request and its
            // scope, which `answer` provides.
            const served = http.pipe(
              Effect.provideContext(Context.add(services, RequestContext, facts)),
            ) as Effect.Effect<
              HttpServerResponse.HttpServerResponse,
              unknown,
              HttpServerRequest.HttpServerRequest | Scope.Scope
            >
            return answer(served, request, facts)
          },
        })
      }),
    )
  }

  static readonly layer = AgentHttp.serve([routeNames(OwnerApi), routeNames(InternalApi)], AgentApiLayer)
}
