import * as Schema from 'effect/Schema'
import { ApprovalDecision, ApprovalView } from './approvals.ts'
import { Address, ChainKey, Hex, Instant, Text, UsdAmount } from './ids.ts'
import { LimitView, WalletLimits } from './limits.ts'
import { Operation } from './operations.ts'
import { Recipient, ServiceRule } from './services.ts'
import { WalletStatusResult } from './status.ts'

/**
 * The owner API the web app calls with `authorization: Bearer <Privy access token>`. Every route acts for the signed-in
 * Privy user only; no route takes an owner id from the request.
 */
export const Config = Schema.Struct({ privyAppId: Text(64), stage: Text(16) })

/** Where onboarding stands, per chain the owner set up. */
export const ChainSetup = Schema.Struct({
  chain: ChainKey,
  upgraded: Schema.Boolean,
  allowance: Schema.optional(Schema.Struct({ perHour: UsdAmount, expiresAt: Instant, delegationHash: Hex })),
})
export type ChainSetup = typeof ChainSetup.Type

export const Me = Schema.Struct({
  userId: Text(80),
  owner: Address,
  agent: Schema.optional(Address),
  chains: Schema.Array(ChainSetup),
  limits: Schema.optional(WalletLimits),
})
export type Me = typeof Me.Type

/** `POST /api/onboarding/upgrade`: the owner's signed EIP-7702 authorization; the relay sends the type-4 transaction. */
export const UpgradeRequest = Schema.Struct({
  chain: ChainKey,
  authorization: Schema.Struct({
    address: Address,
    chainId: Schema.Int,
    nonce: Schema.Int,
    r: Hex,
    s: Hex,
    yParity: Schema.Int,
  }),
})
export type UpgradeRequest = typeof UpgradeRequest.Type

/** `POST /api/allowance/prepare` returns the exact ERC-7710 delegation to sign; the browser rebuilds and compares it. */
export const AllowancePrepare = Schema.Struct({ chain: ChainKey, perHour: UsdAmount, days: Schema.Int })
export const AllowanceDraft = Schema.Struct({ chain: ChainKey, typedData: Schema.Unknown, delegationHash: Hex })
export const AllowanceConfirm = Schema.Struct({ chain: ChainKey, delegationHash: Hex, signature: Hex })

export const Connection = Schema.Struct({
  id: Text(80),
  client: Text(120),
  scopes: Schema.Array(Text(40)),
  createdAt: Instant,
  lastUsedAt: Schema.optional(Instant),
})
export type Connection = typeof Connection.Type

/** `GET /api/oauth/requests/:id` for the consent page, and the owner's answer. */
export const OAuthRequestView = Schema.Struct({
  id: Text(80),
  client: Text(120),
  redirectHost: Text(253),
  scopes: Schema.Array(Text(40)),
  expiresAt: Instant,
})
export const OAuthDecision = Schema.Struct({ decision: Schema.Literals(['approve', 'deny']) })

/** The route table: method, path, request and response schema of every owner route. */
export const OwnerRoutes = {
  config: { method: 'GET', path: '/api/config', response: Config },
  me: { method: 'GET', path: '/api/me', response: Me },
  status: { method: 'GET', path: '/api/status', response: WalletStatusResult },
  createAgent: { method: 'POST', path: '/api/onboarding/agent', response: Me },
  upgrade: { method: 'POST', path: '/api/onboarding/upgrade', request: UpgradeRequest, response: Operation },
  allowancePrepare: {
    method: 'POST',
    path: '/api/allowance/prepare',
    request: AllowancePrepare,
    response: AllowanceDraft,
  },
  allowanceConfirm: { method: 'POST', path: '/api/allowance/confirm', request: AllowanceConfirm, response: Me },
  limits: { method: 'GET', path: '/api/limits', response: Schema.Array(LimitView) },
  setLimits: { method: 'PUT', path: '/api/limits', request: WalletLimits, response: WalletLimits },
  activity: { method: 'GET', path: '/api/activity', response: Schema.Array(Operation) },
  approval: { method: 'GET', path: '/api/approvals/:operationId', response: ApprovalView },
  decide: { method: 'POST', path: '/api/approvals/:operationId', request: ApprovalDecision, response: ApprovalView },
  services: { method: 'GET', path: '/api/services', response: Schema.Array(ServiceRule) },
  addressBook: { method: 'GET', path: '/api/address-book', response: Schema.Array(Recipient) },
  connections: { method: 'GET', path: '/api/connections', response: Schema.Array(Connection) },
  disconnect: { method: 'DELETE', path: '/api/connections/:id', response: Schema.Array(Connection) },
  oauthRequest: { method: 'GET', path: '/api/oauth/requests/:id', response: OAuthRequestView },
  oauthDecide: {
    method: 'POST',
    path: '/api/oauth/requests/:id',
    request: OAuthDecision,
    response: Schema.Struct({ redirectTo: Text(2048) }),
  },
  revokeAll: { method: 'POST', path: '/api/revoke', response: Me },
} as const

/** The JSON error envelope of every route. */
export const ApiError = Schema.Struct({
  error: Schema.Struct({ code: Text(64), message: Text(400), recovery: Schema.optional(Text(400)) }),
})
