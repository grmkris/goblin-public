import { AccountApi, type AppError, BillingRefused, withRef } from '@goblin/contracts/api'
import type { BillingState, ClientErrorReport, InboundClient } from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { listInboundClients, revokeInboundClient } from '../../auth/clients.ts'
import { billingMode } from '../../billing/gates.ts'
import { planOf } from '../../billing/reconcile.ts'
import { billingDeps, startCheckout } from '../../billing/routes.ts'
import { makeBillingStore } from '../../billing/store.ts'
import type { RuntimeEnv } from '../../env.ts'
import { logEvent } from '../../observability/logger.ts'
import { expectedFailure } from '../../observability/report.ts'
import { Unauthenticated, toAppError } from '../errors.ts'
import { RequestContext } from './context.ts'

/** The account's own records the Worker answers from: D1 and the payment provider, never the agent. */
export interface AccountRecords {
  readonly clients: (userId: string) => Effect.Effect<readonly InboundClient[], AppError>
  readonly revokeClient: (userId: string, clientId: string) => Effect.Effect<void, AppError>
  readonly billingState: (userId: string) => Effect.Effect<BillingState, AppError>
  readonly checkout: (
    userId: string,
  ) => Effect.Effect<{ readonly checkoutUrl: string; readonly sessionId: string }, BillingRefused | AppError>
  readonly portal: (userId: string) => Effect.Effect<{ readonly url: string }, BillingRefused | AppError>
}

/** A refusal that is an answer, not a fault: the reporter skips it. */
const refused = (code: BillingRefused['code']) =>
  Effect.fail(expectedFailure(new BillingRefused({ code }), code === 'billing_unavailable' ? 'lower' : 'skip'))

/** A promise of the auth store, its failure an `AppError` (an unexpected one reported by `toAppError`). */
const stored = <A>(read: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: read, catch: toAppError })

/** The records as the deployment keeps them: the auth D1 and, when it is configured, the payment provider. */
export const accountRecords = (env: RuntimeEnv): AccountRecords => {
  const store = makeBillingStore(env.AUTH_DB)
  const deps = billingDeps(env)
  const stage = env.STAGE ?? 'test'
  return {
    clients: (userId) => stored(() => listInboundClients(env, userId)),
    revokeClient: (userId, clientId) => stored(() => revokeInboundClient(env, userId, clientId)),
    billingState: (userId) =>
      Effect.map(planOf(store, userId, stage, billingMode(env)), (plan) => ({
        ...plan,
        mode: deps?.dodo.mode ?? null,
        plan: plan.active ? ('pro' as const) : null,
        priceCents: 1000,
      })),
    checkout: (userId) =>
      deps === undefined
        ? refused('billing_unavailable')
        : startCheckout(deps, userId, env.APP_URL, stage).pipe(
            Effect.mapError(toAppError),
            Effect.flatMap((result) =>
              'error' in result
                ? refused(result.error)
                : Effect.succeed({ checkoutUrl: result.checkoutUrl, sessionId: result.sessionId }),
            ),
          ),
    portal: (userId) =>
      deps === undefined
        ? refused('billing_unavailable')
        : Effect.gen(function* () {
            const account = yield* store.account(userId)
            if (account?.customerId == null) return yield* refused('no_customer')
            return { url: yield* Effect.mapError(deps.dodo.portalUrl(account.customerId), toAppError) }
          }),
  }
}

/**
 * What one account request carries past the edge's admission: the records, and the signed-in user when the endpoint
 * needs one (every endpoint but a client error report).
 */
export class AccountRequest extends Context.Service<
  AccountRequest,
  { readonly records: AccountRecords; readonly userId: Option.Option<string> }
>()('goblin/http/AccountRequest') {}

/** The signed-in user. Admission has checked the session already; this only says so to the types. */
const signedIn = AccountRequest.use(({ records, userId }) =>
  Option.match(userId, {
    onNone: () => Effect.fail(new Unauthenticated({ reason: 'session required' })),
    onSome: (user) => Effect.succeed({ records, user }),
  }),
)

/** `error` quoting `ref`, the reference its answer carries. */
const stamp = (error: AppError | BillingRefused, ref: string): Effect.Effect<AppError | BillingRefused> =>
  error instanceof BillingRefused ? Effect.succeed(new BillingRefused({ code: error.code, ref })) : withRef(ref)(error)

/** `self`, its failure quoting the request's reference, as the owner gate quotes it. */
const quoted = <A, E extends AppError | BillingRefused, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(RequestContext), (context) => {
    const ref = Option.getOrUndefined(context)?.ref
    if (ref === undefined) return self
    return Effect.catch(self, (error) =>
      // SAFETY: stamping the reference keeps the failure's class and fields, so it is still the `E` it was.
      Effect.flatMap(stamp(error, ref), (stamped) => Effect.fail(stamped as E)),
    )
  })

/** Frame locations as the browser sent them, without query or fragment. */
const location = (frame: string): string => frame.replace(/[?#][^\s]*?(?=:\d{1,7}:\d{1,7}$)/u, '')

/** One content-free line per crash report (ADR 0024); the flow sink takes it once it exists. */
const logReport = (report: ClientErrorReport) =>
  logEvent('warn', 'client_error', {
    route: report.route,
    name: report.name,
    frames: report.frames.map(location),
    build: report.build,
    ...(report.ref === undefined ? {} : { ref: report.ref }),
  })

const BillingHandlers = HttpApiBuilder.group(AccountApi, 'billing', (handlers) =>
  handlers
    .handle('state', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.billingState(user))))
    .handle('checkout', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.checkout(user))))
    .handle('portal', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.portal(user)))),
)

const ClientsHandlers = HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.clients(user))))
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, user }) =>
          Effect.as(records.revokeClient(user, params.clientId), { revoked: true as const }),
        ),
      ),
    ),
)

const ClientErrorsHandlers = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) =>
  handlers.handle('report', ({ payload }) => logReport(payload)),
)

/** The account API's routes, served by the Worker (`edge.ts`). */
export const AccountApiLayer = HttpApiBuilder.layer(AccountApi).pipe(
  Layer.provide([BillingHandlers, ClientsHandlers, ClientErrorsHandlers]),
  Layer.provide(HttpServer.layerServices),
)
