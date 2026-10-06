import { authFixtureRoute, fixtureAuth } from './auth-fixture.ts'
import { Effect } from 'effect'
import runtime from '../../src/worker.ts'
import type { RuntimeEnv } from '../../src/env.ts'
import { requireUserSession } from '../../src/auth/index.ts'
import { liveApi, type DodoApi } from '../../src/billing/dodo.ts'
import { makeBillingStore } from '../../src/billing/store.ts'
import { startCheckout } from '../../src/billing/routes.ts'
import { billingWebhook } from '../../src/billing/webhook.ts'
import { billingTestRoute } from '../../src/billing/test-route.ts'
import { failureResponse } from '../../src/http/respond.ts'
import { PersonalAgent } from '../../src/agent.ts'
import { scriptedStreams } from './model.ts'

// Fixed fixture key, signs no real billing data.
const FIXTURE_KEY = 'whsec_Zml4dHVyZS1iaWxsaW5nLXNpZ25pbmcta2V5'
const dodo: DodoApi = {
  mode: 'test_mode',
  createCheckout: (input) =>
    Effect.succeed({
      sessionId: crypto.randomUUID(),
      checkoutUrl: `https://checkout.fixture.test/pay?product=${encodeURIComponent(input.productId)}&return=${encodeURIComponent(input.returnUrl)}&user=${encodeURIComponent(input.metadata['userId'] ?? '')}`,
    }),
  portalUrl: (customerId) => Effect.succeed(`https://portal.fixture.test/${encodeURIComponent(customerId)}`),
  getSubscription: () => Effect.succeed({}),
  paymentSubscriptionId: () => Effect.succeed(null),
  verify: liveApi('test_mode', 'unused-fixture', FIXTURE_KEY).verify,
}
/** Real account policy and actual PersonalAgent, with only the model stream replaced by the native test fixture. */
export class BillingAgent extends PersonalAgent {
  protected override modelStreams() {
    return scriptedStreams(() => undefined)
  }
}
export default {
  async fetch(request: Request, env: RuntimeEnv, ctx: ExecutionContext) {
    const url = new URL(request.url)
    const canonical = new URL(url.pathname + url.search, env.APP_URL)
    const input = new Request(canonical, request)
    const deps = { store: makeBillingStore(env.AUTH_DB), dodo, productId: 'pdt_goblin_fixture' }
    env = fixtureAuth(request, env)
    try {
      const authProbe = await authFixtureRoute(input, env)
      if (authProbe !== undefined) return authProbe
      if (url.pathname === '/hooks/dodo') return await Effect.runPromise(billingWebhook(deps, input, ctx))
      if (url.pathname.startsWith('/__test/billing/'))
        return await Effect.runPromise(billingTestRoute(input, env, deps))
      if (url.pathname === '/api/billing/checkout') {
        const { userId } = await requireUserSession(input, env)
        const { status, ...body } = await Effect.runPromise(startCheckout(deps, userId, env.APP_URL, 'test'))
        return Response.json(body, { status })
      }
      return await runtime.fetch(input, env, ctx)
    } catch (cause) {
      return failureResponse(cause, url.pathname, 'billing-fixture')
    }
  },
}
