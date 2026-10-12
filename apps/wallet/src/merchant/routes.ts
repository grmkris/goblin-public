import {
  CollectRequest,
  type MerchantSubscription,
  MerchantRoutes,
  type SubscriptionCreated,
  SubscriptionRequest,
} from '@goblin/wallet/contract'
import { MAX_PERIODS } from '@goblin/wallet/delegation'
import { readBody } from '../api/call.ts'
import type { WalletEnv } from '../env.ts'
import { apiError, json } from '../http.ts'
import type { SubscriptionApi } from '../oauth/durable.ts'
import { type CollectDeps, collect } from './collect.ts'
import { GOBLIN_MERCHANT, type MerchantConfig, allowedReturn, merchantAuthorized, merchantConfig } from './config.ts'
import { REQUEST_TTL_S, type SubscriptionRow, statusAt } from './store.ts'

export interface MerchantDeps {
  readonly store: (env: WalletEnv) => SubscriptionApi
  /** The collector's chain access and signer; built only for a collection. */
  readonly collector: (env: WalletEnv, config: MerchantConfig) => Promise<CollectDeps>
  /** Epoch milliseconds. */
  readonly now?: () => number
}

const ID = /^sub_[0-9a-f]{32}$/u
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()

const newId = (): string =>
  `sub_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`

/** The subscription as the merchant may see it: never the owner's Privy id, only their address once they signed. */
export const merchantView = (row: SubscriptionRow, now: number): MerchantSubscription => ({
  id: row.id,
  reference: row.reference,
  status: statusAt(row, now),
  chain: 'base',
  amountUsd: row.amountUsd,
  periodDays: row.periodDays,
  collector: row.collector,
  ...(row.ownerAddress === null ? {} : { owner: row.ownerAddress }),
  ...(row.startsAt === null ? {} : { startsAt: iso(row.startsAt) }),
  ...(row.expiresAt === null ? {} : { expiresAt: iso(row.expiresAt) }),
  ...(row.delegationHash === null ? {} : { delegationHash: row.delegationHash }),
})

/** `POST /api/merchant/subscriptions`: a request for the owner to sign, at a page of this wallet. */
async function create(request: Request, env: WalletEnv, config: MerchantConfig, deps: MerchantDeps) {
  const body = await readBody(request, SubscriptionRequest)
  if (!body.ok) return body.response
  const target = allowedReturn(config, body.value.returnUrl)
  if (target === undefined)
    return apiError('return_not_allowed', 'The return address is not on one of your allowed origins.', 400)
  if (config.collector === undefined)
    return apiError('collector_missing', 'This wallet has no collector to pay into yet.', 503, 'Try again later.')
  if (body.value.months > MAX_PERIODS) return apiError('invalid_request', 'Too many periods.', 400)
  const id = newId()
  const now = Math.floor((deps.now?.() ?? Date.now()) / 1000)
  target.searchParams.set('subscription', id)
  await deps.store(env).createSubscription({
    id,
    merchant: GOBLIN_MERCHANT,
    reference: body.value.reference,
    amountUsd: body.value.amountUsd,
    periodDays: body.value.periodDays,
    months: body.value.months,
    returnUrl: target.href,
    collector: config.collector.address,
    now,
  })
  const created: SubscriptionCreated = {
    id,
    signUrl: new URL(`/subscribe/${id}`, request.url).href,
    expiresAt: iso(now + REQUEST_TTL_S),
  }
  return json(created, 201)
}

/** The route and the subscription id a merchant path names. */
const routeOf = (
  method: string,
  pathname: string,
): { route: 'create' | 'get' | 'collect'; id?: string } | undefined => {
  if (method === MerchantRoutes.create.method && pathname === MerchantRoutes.create.path) return { route: 'create' }
  const found = /^\/api\/merchant\/subscriptions\/([^/]{1,80})(\/collect)?$/u.exec(pathname)
  const id = found?.[1]
  if (id === undefined || !ID.test(id)) return undefined
  if (found?.[2] === undefined) return method === MerchantRoutes.get.method ? { route: 'get', id } : undefined
  return method === MerchantRoutes.collect.method ? { route: 'collect', id } : undefined
}

/**
 * The merchant API under `/api/merchant/*` (ADR 0054): goblin's server, with its bearer merchant key, asks for a
 * subscription, reads it and collects a period. It never reaches an owner's ledger or the owner API; a merchant sees
 * only its own subscriptions.
 */
export function createMerchantApi(deps: MerchantDeps): (request: Request, env: WalletEnv) => Promise<Response> {
  return async (request, env) => {
    const config = merchantConfig(env)
    if (config.key === '') return apiError('not_found', 'No such route.', 404)
    if (!(await merchantAuthorized(config, request)))
      return apiError('unauthenticated', 'The merchant key is missing or wrong.', 401)
    const { pathname } = new URL(request.url)
    const matched = routeOf(request.method, pathname)
    if (matched === undefined) return apiError('not_found', 'No such route.', 404)
    if (matched.route === 'create') return create(request, env, config, deps)
    const store = deps.store(env)
    const row = await store.merchantSubscription(matched.id ?? '', GOBLIN_MERCHANT)
    if (row === undefined) return apiError('not_found', 'No such subscription.', 404)
    const nowMs = deps.now?.() ?? Date.now()
    if (matched.route === 'get') return json(merchantView(row, Math.floor(nowMs / 1000)))
    const body = await readBody(request, CollectRequest)
    if (!body.ok) return body.response
    return json(await collect(store, await deps.collector(env, config), row, body.value))
  }
}
