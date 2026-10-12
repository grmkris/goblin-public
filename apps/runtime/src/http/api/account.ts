import { AccountApi, type AppError, BillingRefused, withRef } from '@goblin/contracts/api'
import type { BillingState, ClientErrorReport, InboundClient, WalletPlan, WalletReceipt } from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { listInboundClients, revokeInboundClient } from '../../auth/clients.ts'
import { billingMode } from '../../billing/gates.ts'
import { freeCredits } from '../../billing/plans.ts'
import { planOf } from '../../billing/reconcile.ts'
import { confirmWalletSubscription, startWalletSubscription } from '../../billing/renewals.ts'
import { billingDeps, startCheckout, walletBillingDeps } from '../../billing/routes.ts'
import type { WalletSubscription } from '../../billing/schema.ts'
import { makeBillingStore } from '../../billing/store.ts'
import { cardCheckoutOn, WalletMerchant } from '../../billing/wallet.ts'
import type { RuntimeEnv } from '../../env.ts'
import { logEvent } from '../../observability/logger.ts'
import { expectedFailure, reportAndRecover } from '../../observability/report.ts'
import { FlowPointFailure, agentHash, flowPoint } from '../../observability/ae.ts'
import { Unauthenticated, attempt, toAppError } from '../errors.ts'
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
  /** Asks the Goblin Wallet for Pro as a subscription the owner signs once (ADR 0054); where to sign it. */
  readonly walletStart: (
    userId: string,
    back: string | undefined,
  ) => Effect.Effect<{ readonly signUrl: string }, BillingRefused | AppError>
  /** The owner came back from signing: takes the first payment, once, and answers its receipt. */
  readonly walletConfirm: (
    userId: string,
    subscriptionId: string,
  ) => Effect.Effect<WalletReceipt, BillingRefused | AppError>
  /**
   * A browser crash's `client_error` flow point (ADR 0037), under the hash of `userId`'s agent when the report came
   * with a session; nothing without the `FLOWS` binding.
   */
  readonly crash: (report: ClientErrorReport, userId: Option.Option<string>) => Effect.Effect<void, FlowPointFailure>
}

/**
 * The `client_error` flow step of a crash report: the browser's user, through the app, ended in an error of the
 * report's type. Content-free (ADR 0024): no route, frames or reference.
 */
const crashStep = (report: ClientErrorReport): FlowEvent => ({
  flow: 'client_error',
  via: 'app',
  actor: 'owner',
  status: 'error',
  errorType: report.name,
})

/**
 * Its Analytics Engine point (`observability/ae.ts`'s layout), with the report's own build. A report needs no session:
 * with one it is indexed by the agent's hash, without one it has no index.
 */
export const crashPoint = (
  report: ClientErrorReport,
  agent: string | undefined,
  stage: string,
): AnalyticsEngineDataPoint => {
  const point = flowPoint(crashStep(report), agent ?? '', { stage, build: report.build })
  return agent === undefined ? { ...point, indexes: [] } : point
}

/** Refusals that are a service not answering, reported as such; every other one is an answer the reporter skips. */
const LOWERED: ReadonlySet<BillingRefused['code']> = new Set([
  'billing_unavailable',
  'wallet_unavailable',
  'payment_failed',
])

/** A refusal that is an answer, not a fault: the reporter skips it. */
const refused = (code: BillingRefused['code']) =>
  Effect.fail(expectedFailure(new BillingRefused({ code }), LOWERED.has(code) ? 'lower' : 'skip'))

/** The wallet subscription as Settings shows it, with where to manage it. */
const walletPlanOf = (row: WalletSubscription, walletOrigin: string): WalletPlan => ({
  status: row.status,
  amountUsd: row.amountUsd,
  periodDays: row.periodDays,
  paidThrough: row.paidThrough,
  nextPaymentAt: row.nextAttemptAt,
  graceUntil: row.graceUntil,
  manageUrl: `${walletOrigin}/limits`,
})

type WalletBilling = NonNullable<ReturnType<typeof walletBillingDeps>>

/** Paying from the Goblin Wallet (ADR 0054): start and confirm, a wallet that does not answer refused as such. */
const walletRecords = (
  wallet: WalletBilling | undefined,
  stage: string,
): Pick<AccountRecords, 'walletStart' | 'walletConfirm'> => {
  return {
    walletStart: (userId, back) =>
      wallet === undefined
        ? refused('wallet_unavailable')
        : startWalletSubscription(wallet.deps, userId, { back, stage }).pipe(
            Effect.provideService(WalletMerchant, wallet.merchant),
            Effect.catchTag('WalletMerchantError', () => refused('wallet_unavailable')),
            Effect.mapError((error) => (error instanceof BillingRefused ? error : toAppError(error))),
            Effect.flatMap((result) => ('error' in result ? refused(result.error) : Effect.succeed(result))),
          ),
    walletConfirm: (userId, subscriptionId) =>
      wallet === undefined
        ? refused('wallet_unavailable')
        : confirmWalletSubscription(wallet.deps, userId, subscriptionId).pipe(
            Effect.provideService(WalletMerchant, wallet.merchant),
            Effect.catchTag('WalletMerchantError', () => refused('wallet_unavailable')),
            Effect.mapError((error) => (error instanceof BillingRefused ? error : toAppError(error))),
            Effect.flatMap((result) => ('error' in result ? refused(result.error) : Effect.succeed(result.receipt))),
          ),
  }
}

/** The records as the deployment keeps them: the auth D1 and, when it is configured, the payment provider. */
export const accountRecords = (env: RuntimeEnv): AccountRecords => {
  const store = makeBillingStore(env.AUTH_DB)
  // The card checkout is off unless the deployment turns it on (ADR 0054); its code stays for when it comes back.
  const card = cardCheckoutOn(env)
  const deps = card ? billingDeps(env) : undefined
  const wallet = walletBillingDeps(env)
  const stage = env.STAGE ?? 'test'
  const flows = env.FLOWS
  return {
    ...walletRecords(wallet, stage),
    crash: (report, userId) =>
      flows === undefined
        ? Effect.void
        : Effect.gen(function* () {
            const agent = Option.isSome(userId) ? yield* agentHash(env.CREDENTIAL_KEY, userId.value) : undefined
            yield* Effect.try({
              try: () => flows.writeDataPoint(crashPoint(report, agent, env.STAGE ?? 'local')),
              catch: (cause) => new FlowPointFailure({ step: 'write', cause }),
            })
          }),
    clients: (userId) => attempt(() => listInboundClients(env, userId)),
    revokeClient: (userId, clientId) => attempt(() => revokeInboundClient(env, userId, clientId)),
    billingState: (userId) =>
      Effect.map(
        Effect.all([
          planOf(store, userId, stage, billingMode(env), { free: freeCredits(env.FREE_DAILY_CREDITS) }),
          store.walletSubscription(userId),
        ]),
        ([plan, row]): BillingState => ({
          ...plan,
          mode: deps?.dodo.mode ?? null,
          plan: plan.active ? (plan.source === 'free' ? ('free' as const) : ('pro' as const)) : null,
          priceCents: 1000,
          walletPay: wallet !== undefined,
          cardCheckout: card,
          ...(row === undefined || wallet === undefined ? {} : { wallet: walletPlanOf(row, wallet.merchant.origin) }),
        }),
      ),
    checkout: (userId) =>
      !card
        ? refused('card_disabled')
        : deps === undefined
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
      !card
        ? refused('card_disabled')
        : deps === undefined
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

/** `self`, its failure quoting the request's reference, as owner admission quotes it. */
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

/** One content-free line per crash report (ADR 0024), then its flow point; a point that fails is reported, not answered. */
const takeReport = (report: ClientErrorReport) =>
  Effect.andThen(
    logReport(report),
    AccountRequest.use(({ records, userId }) => records.crash(report, userId)).pipe(
      reportAndRecover('http.clientErrors', undefined),
    ),
  )

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
    .handle('portal', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.portal(user))))
    .handle('walletStart', ({ payload }) =>
      quoted(Effect.flatMap(signedIn, ({ records, user }) => records.walletStart(user, payload.return))),
    )
    .handle('walletConfirm', ({ payload }) =>
      quoted(Effect.flatMap(signedIn, ({ records, user }) => records.walletConfirm(user, payload.subscription))),
    ),
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
  handlers.handle('report', ({ payload }) => takeReport(payload)),
)

/** The account API's routes, served by the Worker (`edge.ts`). */
export const AccountApiLayer = HttpApiBuilder.layer(AccountApi).pipe(
  Layer.provide([BillingHandlers, ClientsHandlers, ClientErrorsHandlers]),
  Layer.provide(HttpServer.layerServices),
)
