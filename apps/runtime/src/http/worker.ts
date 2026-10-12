import * as Effect from 'effect/Effect'
import type { AgentRpc, RuntimeEnv } from '../env.ts'
import { handleAuth, resourceMetadata, requireUserSession } from '../auth/index.ts'
import { mailerOf } from '../auth/mail.ts'
import { signupMode } from '../auth/signup.ts'
import { readBytes } from './body.ts'
import { InvalidInput, NotFound, attempt } from './errors.ts'
import { accountRecords } from './api/account.ts'
import { type Edge, type EdgeHttp, isAccountPath, makeEdgeHttp, runAtEdge } from './api/edge.ts'
import { secured } from './api/render.ts'
import { deliverEvents, internalCall } from '../inbound/client.ts'
import { handleInboundMcp } from '../inbound/route.ts'
import { eventsHookTokenValid } from '../mcp/events/route-token.ts'
import { EVENT_BODY_BYTES } from '../mcp/events/webhook.ts'
import { hookTokenValid } from '../channel/doorbell.ts'
import { canonicalRedirect } from './canonical.ts'
import { billingDeps, walletBillingDeps } from '../billing/routes.ts'
import { billingWebhook } from '../billing/webhook.ts'
import { runBillingCron, runWalletCron } from '../billing/cron.ts'
import { billingMode, accountPlan } from '../billing/gates.ts'
import { paidCompletion } from './paid-inference.ts'

/** Only the authenticated user ID supplies the native Agent name. */
const agentOf = (env: RuntimeEnv, userId: string): DurableObjectStub<AgentRpc> => env.AGENTS.getByName(userId)

/** The deployment as the typed API's edge sees it (`http/api/edge.ts`). */
const edgeOf = (env: RuntimeEnv): Edge => ({
  origin: new URL(env.APP_URL).origin,
  session: (request) =>
    Effect.map(
      attempt(() => requireUserSession(request, env)),
      (session) => session.userId,
    ),
  plan: (userId) => Effect.asVoid(accountPlan(env, userId)),
  agent: (userId) => agentOf(env, userId),
  records: accountRecords(env),
})

/** The edge, built once per isolate on its first request. */
let edgeHttp: Promise<EdgeHttp> | undefined
const edge = (): Promise<EdgeHttp> => (edgeHttp ??= runAtEdge(makeEdgeHttp))

/** The largest doorbell body accepted (myagent sends `{ botId, cursor }`). */
const DOORBELL_BYTES = 1024

/**
 * POST /hooks/myagent/<userId>/<token>: a doorbell from myagent (channel/doorbell.ts). The token is checked here,
 * before any agent wakes; only the user it was made for reaches their agent, which checks its plan and myagent's
 * signature.
 */
async function doorbellRoute(request: Request, env: RuntimeEnv, path: string, ref: string): Promise<Response> {
  const [, userId = '', token = ''] = /^\/hooks\/myagent\/([\w-]{1,200})\/([\w-]{43})$/u.exec(path) ?? []
  if (request.method !== 'POST' || userId === '' || !(await hookTokenValid(env.CREDENTIAL_KEY, userId, token)))
    throw new NotFound({ what: 'route' })
  const body = await request.text()
  if (body.length > DOORBELL_BYTES) throw new InvalidInput({ reason: 'doorbell too large' })
  const doorbell = {
    body,
    timestamp: request.headers.get('x-myagent-timestamp') ?? '',
    signature: request.headers.get('x-myagent-signature') ?? '',
  }
  await runAtEdge(internalCall(agentOf(env, userId), (api) => api.inbound.doorbell({ payload: doorbell }), ref))
  return new Response(null, { status: 204 })
}

/**
 * POST /hooks/mcp-events/<userId>/<connectionId>/<token>: one connection's MCP Events webhook. The route token, bound
 * to the user and the connection, is checked before any agent wakes, and the raw bytes are bounded before the agent
 * checks its plan and the signature.
 */
async function mcpEventsRoute(request: Request, env: RuntimeEnv, path: string, ref: string): Promise<Response> {
  const [, userId = '', connectionId = '', token = ''] =
    /^\/hooks\/mcp-events\/([\w-]{1,200})\/([\w-]{1,64})\/([\w-]{43})$/u.exec(path) ?? []
  if (
    request.method !== 'POST' ||
    userId === '' ||
    !(await eventsHookTokenValid(env.CREDENTIAL_KEY, userId, connectionId, token))
  )
    throw new NotFound({ what: 'route' })
  const webhook = {
    connectionId,
    body: await readBytes(request, EVENT_BODY_BYTES),
    subscriptionId: request.headers.get('x-mcp-subscription-id') ?? '',
    id: request.headers.get('webhook-id') ?? '',
    timestamp: request.headers.get('webhook-timestamp') ?? '',
    signature: request.headers.get('webhook-signature') ?? '',
  }
  const result = await runAtEdge(deliverEvents(agentOf(env, userId), webhook, ref))
  return new Response(result.response ?? null, {
    status: result.status,
    ...(result.response === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
  })
}

/** The Worker's own routes past the typed API: /mcp and the hooks. Anything else, `/internal/*` included, is a 404. */
async function workerRoute(
  request: Request,
  env: RuntimeEnv,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  ref: string,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (path === '/mcp') return handleInboundMcp(request, env)
  if (path === '/hooks/dodo') return runAtEdge(billingWebhook(billingDeps(env), request, ctx))
  if (path.startsWith('/hooks/mcp-events/')) return mcpEventsRoute(request, env, path, ref)
  if (path.startsWith('/hooks/')) return doorbellRoute(request, env, path, ref)
  // goblin's own model endpoint, paid per call over MPP (ADR 0047), where the stage sells it.
  const paid = path === '/v1/chat/completions' ? await paidCompletion(request, env) : undefined
  if (paid !== undefined) return paid
  throw new NotFound({ what: 'route' })
}

/**
 * The deployed Worker's handlers (`worker.ts` exports them with the agent's class): the billing cron, and every request
 * the web worker forwards (`apps/web/src/worker.ts`): health, auth, the typed API's edge, /mcp and the hooks.
 */
export const worker = {
  async scheduled(_event: ScheduledController, env: RuntimeEnv): Promise<void> {
    await runAtEdge(runBillingCron(billingDeps(env)))
    await runAtEdge(runWalletCron(walletBillingDeps(env)))
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
          wallet: walletBillingDeps(env) !== undefined,
        },
      })
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return secured(Response.json(resourceMetadata(env)), undefined)
    if (url.pathname.startsWith('/.well-known/') || url.pathname.startsWith('/api/auth/'))
      return handleAuth(request, env)
    // The typed API: the account's own endpoints answered here, every other `/api/*` request admitted and forwarded
    // to the owner's own agent (http/api/edge.ts).
    if (isAccountPath(url.pathname)) return runAtEdge((await edge()).account(request, edgeOf(env)))
    if (url.pathname.startsWith('/api/')) return runAtEdge((await edge()).owner(request, edgeOf(env)))

    // Every answer quotes the request's reference (its cf-ray), which its failure line carries too.
    return runAtEdge((await edge()).route(request, (ref) => attempt(() => workerRoute(request, env, ctx, ref))))
  },
}
