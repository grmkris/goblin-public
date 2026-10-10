import { NotFound, OwnerApi } from '@goblin/contracts/api'
import { FORWARDED_HEADER, INTERNAL_PREFIX, InternalApi } from '@goblin/contracts/internal'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
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
 * `handle` answers a request that names an endpoint of either API. An internal path forwarded for the owner (it
 * carries the edge's `x-goblin-forwarded`) and any other internal path are a 404 in the envelope; any other path is
 * `None`, which the agent's raw routes (`agent-requests.ts`) still serve.
 */
export class AgentHttp extends Context.Service<
  AgentHttp,
  { readonly handle: (request: Request) => Effect.Effect<Option.Option<Response>> }
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
            const path = new URL(request.url).pathname
            const internal = under(path, INTERNAL_PREFIX)
            const route = internal && request.headers.has(FORWARDED_HEADER) ? undefined : routeOf(request)
            if (route === undefined) {
              if (!internal) return Effect.succeedNone
              return Effect.succeed(Option.some(refusal(new NotFound({ what: 'route' }), forwardedRef(request))))
            }
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
            return Effect.map(answer(served, request, facts), Option.some)
          },
        })
      }),
    )
  }

  static readonly layer = AgentHttp.serve([routeNames(OwnerApi), routeNames(InternalApi)], AgentApiLayer)
}
