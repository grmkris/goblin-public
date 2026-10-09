import * as Effect from 'effect/Effect'
import type { AgentRpc, RuntimeEnv } from './env.ts'
import { handleAuth, resourceMetadata, requireUserSession } from './auth/index.ts'
import { mailerOf } from './auth/mail.ts'
import { signupMode } from './auth/signup.ts'
import { readBytes } from './http/body.ts'
import { InvalidInput, NotFound, toAppError } from './http/errors.ts'
import { failureResponse } from './http/respond.ts'
import { accountRecords } from './http/api/account.ts'
import { type Edge, type EdgeHttp, isAccountPath, makeEdgeHttp, refOf } from './http/api/edge.ts'
import { secured } from './http/api/render.ts'
import { unwrap } from './http/rpc.ts'
import { handleInboundMcp } from './inbound/route.ts'
import { eventsHookTokenValid } from './mcp/events/route-token.ts'
import { EVENT_BODY_BYTES } from './mcp/events/webhook.ts'
import { hookTokenValid } from './channel/doorbell.ts'
import { canonicalRedirect } from './http/canonical.ts'
import { billingDeps } from './billing/routes.ts'
import { billingWebhook } from './billing/webhook.ts'
import { runBillingCron } from './billing/cron.ts'
import { billingMode, accountPlan } from './billing/gates.ts'

export { PersonalAgent } from './agent.ts'

/** Only the authenticated user ID supplies the native Agent name. */
const agentOf = (env: RuntimeEnv, userId: string): DurableObjectStub<AgentRpc> => env.AGENTS.getByName(userId)

/** The deployment as the typed API's edge sees it (`http/api/edge.ts`). */
const edgeOf = (env: RuntimeEnv): Edge => ({
  origin: new URL(env.APP_URL).origin,
  session: (request) =>
    Effect.map(
      Effect.tryPromise({ try: () => requireUserSession(request, env), catch: toAppError }),
      (session) => session.userId,
    ),
  plan: (userId) => Effect.asVoid(accountPlan(env, userId)),
  agent: (userId) => agentOf(env, userId),
  records: accountRecords(env),
})

/** The edge, built once per isolate on its first request. */
let edgeHttp: Promise<EdgeHttp> | undefined
const edge = (): Promise<EdgeHttp> => (edgeHttp ??= Effect.runPromise(makeEdgeHttp))

/** The largest doorbell body accepted (myagent sends `{ botId, cursor }`). */
const DOORBELL_BYTES = 1024

/**
 * POST /hooks/myagent/<userId>/<token>: a doorbell from myagent (channel/doorbell.ts). The token is checked here,
 * before any agent wakes; only the user it was made for reaches their agent, which checks myagent's signature.
 */
async function doorbellRoute(request: Request, env: RuntimeEnv, path: string): Promise<Response> {
  const [, userId = '', token = ''] = /^\/hooks\/myagent\/([\w-]{1,200})\/([\w-]{43})$/u.exec(path) ?? []
  if (request.method !== 'POST' || userId === '' || !(await hookTokenValid(env.CREDENTIAL_KEY, userId, token)))
    throw new NotFound({ what: path })
  await Effect.runPromise(accountPlan(env, userId))
  const body = await request.text()
  if (body.length > DOORBELL_BYTES) throw new InvalidInput({ reason: 'doorbell too large' })
  unwrap(
    await agentOf(env, userId).channelDoorbell({
      body,
      timestamp: request.headers.get('x-myagent-timestamp') ?? '',
      signature: request.headers.get('x-myagent-signature') ?? '',
    }),
  )
  return new Response(null, { status: 204 })
}

/** User-bound route token precedes object lookup; raw bytes are bounded before RPC/signature verification. */
async function mcpEventsRoute(request: Request, env: RuntimeEnv, path: string): Promise<Response> {
  const [, userId = '', token = ''] = /^\/hooks\/mcp-events\/([\w-]{1,200})\/([\w-]{43})$/u.exec(path) ?? []
  if (request.method !== 'POST' || userId === '' || !(await eventsHookTokenValid(env.CREDENTIAL_KEY, userId, token)))
    throw new NotFound({ what: path })
  await Effect.runPromise(accountPlan(env, userId))
  const body = await readBytes(request, EVENT_BODY_BYTES)
  const result = unwrap(
    await agentOf(env, userId).mcpEventsWebhook({
      body,
      subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
      id: request.headers.get('webhook-id') ?? '',
      timestamp: request.headers.get('webhook-timestamp') ?? '',
      signature: request.headers.get('webhook-signature') ?? '',
    }),
  )
  return new Response(result.response ?? null, {
    status: result.status,
    ...(result.response === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })
}

async function admittedRoute(
  request: Request,
  env: RuntimeEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/mcp') return handleInboundMcp(request, env)
  if (path === '/hooks/dodo') return Effect.runPromise(billingWebhook(billingDeps(env), request, ctx))
  if (path.startsWith('/hooks/mcp-events/')) return mcpEventsRoute(request, env, path)
  if (path.startsWith('/hooks/')) return doorbellRoute(request, env, path)
  throw new NotFound({ what: path })
}

export default {
  async scheduled(_event: ScheduledController, env: RuntimeEnv): Promise<void> {
    await Effect.runPromise(runBillingCron(billingDeps(env)))
  },
  async fetch(request: Request, env: RuntimeEnv, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response> {
    const redirect = canonicalRedirect(request, env.APP_URL)
    if (redirect !== undefined) return redirect
    const url = new URL(request.url)
    if (url.pathname === '/health')
      return Response.json({
        ok: true,
        service: 'goblin',
        stage: env.STAGE,
        signup: signupMode(env.SIGNUP_MODE),
        mail: mailerOf(env) !== undefined,
        billing: {
          mode: env.DODO_PAYMENTS_ENVIRONMENT ?? billingMode(env),
          configured: billingDeps(env) !== undefined,
        },
      })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return secured(Response.json(resourceMetadata(env)), undefined)
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/api/auth/'))
      return handleAuth(request, env)
    // The typed API: the account's own endpoints answered here, every other `/api/*` request admitted and forwarded
    // to the owner's own agent (http/api/edge.ts).
    if (isAccountPath(url.pathname)) return Effect.runPromise((await edge()).account(request, edgeOf(env)))
    if (url.pathname.startsWith('/api/')) return Effect.runPromise((await edge()).owner(request, edgeOf(env)))

    // Every answer quotes the request's reference (its cf-ray), which its failure line carries too.
    const ref = refOf(request)
    try {
      return secured(await admittedRoute(request, env, ctx), ref)
    } catch (cause) {
      return secured(failureResponse(cause, url.pathname, ref), ref)
    }
  },
}
