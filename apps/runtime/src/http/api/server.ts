import { OwnerApi } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Scope from 'effect/Scope'
import * as HttpRouter from 'effect/http/HttpRouter'
import type * as HttpServerRequest from 'effect/http/HttpServerRequest'
import type * as HttpServerResponse from 'effect/http/HttpServerResponse'
import type * as HttpApi from 'effect/http-api/HttpApi'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { RequestContext, requestFacts, routeNames } from './context.ts'
import { OwnerApiLayer } from './groups.ts'
import { answer } from './render.ts'

/**
 * The owner API served inside the agent (ADR 0038 to come): the router is built once, in the agent's own runtime and
 * the layer's scope, never at module level. `handle` answers a request that names an owner endpoint and is `None` for
 * any other path, which the agent's raw routes (`agent-requests.ts`) still serve.
 */
export class OwnerHttp extends Context.Service<
  OwnerHttp,
  { readonly handle: (request: Request) => Effect.Effect<Option.Option<Response>> }
>()('goblin/http/OwnerHttp') {
  /**
   * Serves `api` through `apiLayer` (its groups' handlers behind the owner gate). The agent serves every group; a test
   * serves one area's groups with only the services that area needs (`test/http/api/serve.ts`).
   */
  static serve<Id extends string, Groups extends HttpApiGroup.Constraint, R>(
    api: HttpApi.HttpApi<Id, Groups>,
    apiLayer: Layer.Layer<never, never, R>,
  ) {
    return Layer.effect(
      OwnerHttp,
      Effect.gen(function* () {
        const services = yield* Effect.context<HttpRouter.Request.Only<'Requires', R>>()
        const http = yield* HttpRouter.toHttpEffect(apiLayer)
        const routeOf = routeNames(api)
        return OwnerHttp.of({
          handle: (request) => {
            const route = routeOf(request)
            if (route === undefined) return Effect.succeedNone
            const facts = requestFacts(request, route)
            // SAFETY: `services` is this layer's context, which holds every service the router's handlers require
            // (`R`'s `Requires`), and no owner group declares a global middleware: what is left is the request and
            // its scope, which `answer` provides.
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

  static readonly layer = OwnerHttp.serve(OwnerApi, OwnerApiLayer)
}
