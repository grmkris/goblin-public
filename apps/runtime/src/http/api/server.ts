import { OwnerApi } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpRouter from 'effect/http/HttpRouter'
import { RequestContext, requestFacts, routeNames } from './context.ts'
import { OwnerApiLayer } from './groups.ts'
import { answer } from './render.ts'

/** What the owner handlers take from the agent's runtime on each request: the services their programs use. */
export type OwnerApiServices = HttpRouter.Request.Only<'Requires', Layer.Services<typeof OwnerApiLayer>>

/**
 * The owner API served inside the agent (ADR 0038 to come): the router is built once, in the agent's own runtime and
 * the layer's scope, never at module level. `handle` answers a request that names an owner endpoint and is `None` for
 * any other path, which the agent's raw routes (`agent-requests.ts`) still serve.
 */
export class OwnerHttp extends Context.Service<
  OwnerHttp,
  { readonly handle: (request: Request) => Effect.Effect<Option.Option<Response>> }
>()('goblin/http/OwnerHttp') {
  static readonly layer = Layer.effect(
    OwnerHttp,
    Effect.gen(function* () {
      const services = yield* Effect.context<OwnerApiServices>()
      const http = yield* HttpRouter.toHttpEffect(OwnerApiLayer)
      const routeOf = routeNames(OwnerApi)
      return OwnerHttp.of({
        handle: (request) => {
          const route = routeOf(request)
          if (route === undefined) return Effect.succeedNone
          const facts = requestFacts(request, route)
          const served = http.pipe(Effect.provideContext(Context.add(services, RequestContext, facts)))
          return Effect.map(answer(served, request, facts), Option.some)
        },
      })
    }),
  )
}
