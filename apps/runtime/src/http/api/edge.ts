import { AccountApi, AppError, ErrorEnvelope, Forbidden, NotFound, OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as HttpRouter from 'effect/http/HttpRouter'
import { type LineLevel, LoggerLive, logEvent } from '../../observability/logger.ts'
import { ReporterLive } from '../../observability/report.ts'
import { readBytes } from '../body.ts'
import { crossOrigin, forgedWrite } from '../csrf.ts'
import { toAppError } from '../errors.ts'
import { AccountApiLayer, AccountRequest, type AccountRecords } from './account.ts'
import { RequestContext, type RequestFacts, requestFacts, routeNames, routeTemplate } from './context.ts'
import { answer, refusal, secured } from './render.ts'

/**
 * The Worker side of the typed API (ADR 0038 to come). The Worker keeps the session, origin, CSRF and fresh plan
 * checks, answers the account API itself and forwards every owner `/api/*` request to the owner's own agent. Until the
 * switch, `worker.ts` serves only the account API through here; the owner routes still go through its own tables.
 */

/**
 * Runs one of the Worker's own programs to its value (the fresh plan reads, the billing webhook and cron, the edge's own
 * build): with the agent's bridge (runtime/bridge.ts), the only place Effects are run. It rejects with the program's
 * failure.
 */
export const runAtEdge = <A, E>(program: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(program)

/** The part of an agent's Durable Object stub the edge calls. */
type AgentFetch = { readonly fetch: (request: Request) => Promise<Response> }

/** What the edge asks of the deployment, for one request. */
export interface Edge {
  /** The app's own origin: every browser write comes from it. */
  readonly origin: string
  /** The signed-in user of a request, from its session cookie alone: any `Authorization` header is refused. */
  readonly session: (request: Request) => Effect.Effect<string, AppError>
  /** Refuses an account without a plan, read fresh on every request (ADR 0015). */
  readonly plan: (userId: string) => Effect.Effect<void, AppError>
  /** The user's own agent: the only one their requests reach. */
  readonly agent: (userId: string) => AgentFetch
  /** The account's own records, for the account API. */
  readonly records: AccountRecords
}

/** What the agent receives besides method, path and body. Cookies and authorization stay at the edge. */
const FORWARDED = [
  'content-type',
  'content-length',
  'accept',
  'last-event-id',
  'x-goblin-request',
  'x-goblin-operation',
  // An MCP App's own calls (`x-mcp-caller: app`) are held to the App's grants rather than the owner's.
  'x-mcp-caller',
] as const
/** The JSON body bound of `http/body.ts`; file uploads stream through to the agent's own limits. */
const JSON_BODY_LIMIT = 65_536
/** A crash report is at most 2 KiB of JSON (`ClientErrorReport`). */
const REPORT_BODY_LIMIT = 4096
const FILES = '/api/files'

/** The edge's reference for a request: Cloudflare's ray id, or a random one where there is none (a local run). */
export const refOf = (request: Request): string =>
  request.headers.get('cf-ray') ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16)

/** A write from a foreign Origin, or one without the CSRF header (`csrf.ts`). */
const refusedWrite = (request: Request, edge: Edge): Effect.Effect<void, AppError> =>
  crossOrigin(request, edge.origin) || forgedWrite(request, edge.origin)
    ? Effect.fail(new Forbidden({ reason: crossOrigin(request, edge.origin) ? 'origin' : 'csrf' }))
    : Effect.void

/**
 * Admission of a signed-in user, in the order the Worker has always checked it: a write from a foreign Origin, the
 * session, the CSRF header on every write, then (when `plan`) the account's plan. The user it admitted.
 */
const admitUser = (request: Request, edge: Edge, plan: boolean): Effect.Effect<string, AppError> =>
  Effect.gen(function* () {
    if (crossOrigin(request, edge.origin)) return yield* new Forbidden({ reason: 'origin' })
    const userId = yield* edge.session(request)
    yield* refusedWrite(request, edge)
    if (plan) yield* edge.plan(userId)
    return userId
  })

/** A body read up to `limit` bytes; past it, `PayloadTooLarge`, as `readJson` refused it. */
const bounded = (request: Request, limit: number): Effect.Effect<Uint8Array<ArrayBuffer> | null, AppError> =>
  request.body === null
    ? Effect.succeed(null)
    : Effect.tryPromise({ try: () => readBytes(request, limit), catch: toAppError })

const isAppError = Schema.is(AppError)
const decodeEnvelope = Schema.decodeUnknownOption(ErrorEnvelope)

/** A failure's code, read from its envelope body; none for any other body. */
const codeOf = (response: Response): Effect.Effect<string | undefined> =>
  response.headers.get('content-type')?.startsWith('application/json') === true
    ? Effect.tryPromise(() => response.clone().json()).pipe(
        Effect.map((body) => Option.getOrUndefined(decodeEnvelope(body))?.error.code),
        // expected: a body that is not an envelope only leaves the code out of the failure line.
        Effect.orElseSucceed(() => undefined),
      )
    : Effect.succeed(undefined)

/** An answer the owner made happen (absent, unpaid, taken, too fast) is information; anything else is a warning. */
const levelOf = (status: number): LineLevel =>
  status >= 500 ? 'error' : [401, 402, 404, 409, 429].includes(status) ? 'info' : 'warn'

/**
 * One `http.failure` line for each failed answer the edge returns, its own refusals and the agent's alike: the route
 * template, method, status, code, reference, the browser's request and operation ids, and the agent. Never content.
 */
const failureLine = (response: Response, facts: RequestFacts, method: string, agent: string | undefined) =>
  response.status < 400
    ? Effect.void
    : Effect.flatMap(codeOf(response), (code) =>
        logEvent(levelOf(response.status), 'http.failure', {
          route: facts.route,
          method,
          status: response.status,
          ...(code === undefined ? {} : { code }),
          ...(facts.ref === undefined ? {} : { ref: facts.ref }),
          ...(facts.request === undefined ? {} : { request: facts.request }),
          ...(facts.operation === undefined ? {} : { operation: facts.operation }),
          ...(agent === undefined ? {} : { agent }),
        }),
      )

/**
 * Runs `serve` for one request: its response, or the envelope of the `AppError` it failed with, quoting the edge's
 * reference, then the failure line. `serve` names the user once it knows them.
 */
const settle = (
  request: Request,
  facts: RequestFacts,
  serve: (known: (userId: string) => void) => Effect.Effect<Response, AppError>,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    let agent: string | undefined
    const served = serve((userId) => {
      agent = userId
    })
    // expected: an AppError is answered as its envelope, and failureLine below logs it.
    const response = yield* Effect.catchIf(served, isAppError, (error) => Effect.succeed(refusal(error, facts.ref)))
    yield* failureLine(response, facts, request.method, agent)
    return response
  })

/** The account API's paths; anything else under them is a 404 in the envelope. */
const ACCOUNT_PATHS = ['/api/billing', '/api/clients', '/api/client-errors'] as const
const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`)
export const isAccountPath = (path: string): boolean => ACCOUNT_PATHS.some((prefix) => under(path, prefix))

/**
 * Each account group's admission: billing for any signed-in account, clients with a plan, crash reports for anyone.
 * A crash report needs no session, but one that comes with a session names its user (its flow point is indexed by
 * the agent's hash).
 */
const admitAccount = (group: string, request: Request, edge: Edge): Effect.Effect<Option.Option<string>, AppError> =>
  group === 'clientErrors'
    ? Effect.andThen(refusedWrite(request, edge), sessionUser(request, edge))
    : Effect.map(admitUser(request, edge, group === 'clients'), Option.some)

/** The signed-in user of a request that may come without a session: none for no cookie, or one that does not admit. */
const sessionUser = (request: Request, edge: Edge): Effect.Effect<Option.Option<string>> =>
  request.headers.has('cookie') ? Effect.option(edge.session(request)) : Effect.succeedNone

export interface EdgeHttp {
  /** Answers a request under the account API's paths (`isAccountPath`) in the Worker, without waking the agent. */
  readonly account: (request: Request, edge: Edge) => Effect.Effect<Response>
  /** Admits an owner request and forwards it to the owner's own agent, which answers it. */
  readonly owner: (request: Request, edge: Edge) => Effect.Effect<Response>
}

/**
 * The edge, built once per isolate: the account API's router lives for the isolate, in a scope that is never closed,
 * with goblin's logger and failure reporter.
 */
export const makeEdgeHttp: Effect.Effect<EdgeHttp> = Effect.gen(function* () {
  const scope = Scope.makeUnsafe()
  const http = yield* HttpRouter.toHttpEffect(AccountApiLayer).pipe(Scope.provide(scope))
  const observed = yield* Layer.build(Layer.mergeAll(LoggerLive, ReporterLive)).pipe(Scope.provide(scope))
  const accountRoute = routeNames(AccountApi)
  const ownerRoute = routeNames(OwnerApi)

  const account = (request: Request, edge: Edge): Effect.Effect<Response> => {
    const path = new URL(request.url).pathname
    const route = accountRoute(request)
    const facts = { ...requestFacts(request, route ?? routeTemplate(path)), ref: refOf(request) }
    const served = settle(request, facts, (known) =>
      Effect.gen(function* () {
        if (route === undefined) return yield* new NotFound({ what: 'route' })
        const group = route.slice(0, route.indexOf('.'))
        const userId = yield* admitAccount(group, request, edge)
        if (Option.isSome(userId)) known(userId.value)
        const limit = group === 'clientErrors' ? REPORT_BODY_LIMIT : JSON_BODY_LIMIT
        const body = yield* bounded(request, limit)
        const admitted = new Request(request.url, { method: request.method, headers: request.headers, body })
        return yield* answer(
          http.pipe(
            Effect.provideService(AccountRequest, { records: edge.records, userId }),
            Effect.provideService(RequestContext, facts),
          ),
          admitted,
          facts,
        )
      }),
    )
    return Effect.provideContext(served, observed)
  }

  const owner = (request: Request, edge: Edge): Effect.Effect<Response> => {
    const url = new URL(request.url)
    const facts = { ...requestFacts(request, ownerRoute(request) ?? routeTemplate(url.pathname)), ref: refOf(request) }
    const served = settle(request, facts, (known) =>
      Effect.gen(function* () {
        const userId = yield* admitUser(request, edge, true)
        known(userId)
        const files = url.pathname === FILES || url.pathname.startsWith(`${FILES}/`)
        const body = files ? request.body : yield* bounded(request, JSON_BODY_LIMIT)
        const headers = new Headers({ 'x-goblin-ref': facts.ref })
        for (const name of FORWARDED) {
          const value = request.headers.get(name)
          if (value !== null) headers.set(name, value)
        }
        // A streamed body needs `duplex` outside workerd (Node, the unit tests); workerd ignores it and its types omit it.
        const init = { method: request.method, headers, body, duplex: 'half' }
        const forwarded = new Request(`https://agent${url.pathname}${url.search}`, init)
        const response = yield* Effect.tryPromise({ try: () => edge.agent(userId).fetch(forwarded), catch: toAppError })
        return secured(response, facts.ref)
      }),
    )
    return Effect.provideContext(served, observed)
  }

  return { account, owner }
})
