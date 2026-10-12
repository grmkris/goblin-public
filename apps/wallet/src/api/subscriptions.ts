import { formatUnits } from '@goblin/wallet/amounts'
import { delegationDisabled, TransferError } from '@goblin/wallet/balances'
import { prepareUserOp, type SubmittedUserOp, submitUserOp } from '@goblin/wallet/bundler'
import { chainByKey } from '@goblin/wallet/chains'
import {
  type RevokeDraft,
  RevokeConfirm,
  type RevokeResult,
  SubscriptionConfirm,
  type SubscriptionView,
} from '@goblin/wallet/contract'
import {
  confirmSubscription,
  type PreparedSubscription,
  prepareSubscription,
  revokeCall,
  type SignedSubscription,
} from '@goblin/wallet/delegation'
import { UPGRADE_FEE_CEILINGS } from '@goblin/wallet/userop'
import { apiError, failureResponse, json } from '../http.ts'
import { GOBLIN_MERCHANT } from '../merchant/config.ts'
import { OTHER_OWNER, type SubscriptionRow, statusAt } from '../merchant/store.ts'
import { chainAccess } from '../owner-deps.ts'
import { decodePendingUpgrade, encodePendingUpgrade, prepared, typedDataOf } from '../rails/upgrade.ts'
import { WalletFailure } from '../services/errors.ts'
import { type ApiCall, readBody } from './call.ts'

/** How long a prepared cancellation can be signed: after that its gas price is stale. */
const REVOKE_TTL_MS = 300_000
const DAY_S = 86_400
const ID = /^sub_[0-9a-f]{32}$/u

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()
const nowS = (): number => Math.floor(Date.now() / 1000)
// SAFETY: the contract's Address and Hex schemas checked the `0x` pattern before these reach the delegation code.
const hex = (value: string): `0x${string}` => value as `0x${string}`

const signedOf = (row: SubscriptionRow): SignedSubscription | undefined =>
  // SAFETY: only `confirm` below writes `signed_json`, with JSON.stringify of a SignedSubscription.
  row.signedJson === null ? undefined : (JSON.parse(row.signedJson) as SignedSubscription)

/** The subscription as its owner sees it, with the end of the last period paid. */
export const viewOf = (row: SubscriptionRow, now: number): SubscriptionView => {
  const signed = signedOf(row)
  const paidThrough =
    row.startsAt === null || row.paidPeriods === 0 ? undefined : row.startsAt + row.paidPeriods * row.periodDays * DAY_S
  return {
    id: row.id,
    merchant: row.merchant === GOBLIN_MERCHANT ? 'goblin' : row.merchant,
    merchantHost: new URL(row.returnUrl).host,
    plan: row.plan,
    amountUsd: row.amountUsd,
    periodDays: row.periodDays,
    months: row.months,
    chain: row.chain,
    collector: row.collector,
    status: statusAt(row, now),
    returnUrl: row.returnUrl,
    requestExpiresAt: iso(row.requestExpiresAt),
    ...(row.startsAt === null ? {} : { startsAt: iso(row.startsAt) }),
    ...(row.expiresAt === null ? {} : { expiresAt: iso(row.expiresAt) }),
    ...(paidThrough === undefined ? {} : { paidThrough: iso(paidThrough) }),
    ...(row.lastPaidAt === null ? {} : { lastPaidAt: iso(row.lastPaidAt) }),
    ...(signed === undefined ? {} : { delegation: signed.delegation }),
  }
}

/** The owner's own subscription named by the path; the first owner to open a request is bound to it. */
const ownRow = async (call: ApiCall): Promise<SubscriptionRow | Response> => {
  const id = call.params['id'] ?? ''
  if (!ID.test(id)) return apiError('subscription_unknown', 'This subscription is not known.', 404)
  const row = await call.subscriptions.viewSubscription(id, call.owner.userId, nowS())
  if (row === OTHER_OWNER)
    return apiError('other_owner', 'Another account opened this request first.', 403, 'Ask for a new one.')
  return row === undefined ? apiError('subscription_unknown', 'This subscription is not known.', 404) : row
}

/** The delegation code throws `code: message`; the owner API answers it as a 400 with that code. */
const refusal = (error: unknown): Response => {
  const text = error instanceof Error ? error.message : String(error)
  const code = /^([a-z_]+):/u.exec(text)?.[1] ?? 'subscription_refused'
  return apiError(code, text.slice(code.length + 1).trim() || 'The subscription was refused.', 400)
}

/** `GET /api/subscriptions/:id`: the request (or subscription) the sign page shows. */
export async function subscriptionView(call: ApiCall): Promise<Response> {
  const row = await ownRow(call)
  return row instanceof Response ? row : json(viewOf(row, nowS()))
}

/** `GET /api/subscriptions`: the owner's signed subscriptions, newest first. */
export async function subscriptionList(call: ApiCall): Promise<Response> {
  const now = nowS()
  return json((await call.subscriptions.ownerSubscriptions(call.owner.userId)).map((row) => viewOf(row, now)))
}

const terms = (row: SubscriptionRow) => ({ amountUsd: row.amountUsd, periodDays: row.periodDays, months: row.months })

/**
 * `POST /api/subscriptions/:id/prepare`: the exact delegation for the owner to sign, kept on the request. The owner's
 * account must be upgraded on Base first: the DeleGator is what checks the signature when the collector redeems.
 */
export async function subscriptionPrepare(call: ApiCall): Promise<Response> {
  const row = await ownRow(call)
  if (row instanceof Response) return row
  if (statusAt(row, nowS()) !== 'pending')
    return apiError('not_pending', 'This request is no longer waiting to be signed.', 409, 'Ask for a new one.')
  const base = (await call.ledger.profile()).chains.find((setup) => setup.chain === 'base')
  if (base?.upgraded !== true)
    return apiError(
      'not_upgraded',
      'Your account is not set up on Base yet.',
      409,
      'Finish setting up your wallet, then sign.',
    )
  let draft: PreparedSubscription
  try {
    draft = prepareSubscription(
      {
        chain: chainByKey('base', call.env.WALLET_LIVE === '1'),
        owner: hex(call.owner.ownerAddress),
        collector: hex(row.collector),
        terms: terms(row),
      },
      Date.now(),
    )
  } catch (error) {
    // expected: the delegation code's refusal (`code: message`) is the owner's 400; nothing was kept.
    return refusal(error)
  }
  if (!(await call.subscriptions.putPrepared(row.id, call.owner.userId, JSON.stringify(draft), nowS())))
    return apiError('not_pending', 'This request is no longer waiting to be signed.', 409, 'Ask for a new one.')
  return json({ typedData: draft.typedData, delegationHash: draft.delegationHash })
}

/** `POST /api/subscriptions/:id/confirm`: checks the owner's signature over the prepared delegation and activates it. */
export async function subscriptionConfirm(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, SubscriptionConfirm)
  if (!body.ok) return body.response
  const row = await ownRow(call)
  if (row instanceof Response) return row
  // SAFETY: only `subscriptionPrepare` above writes `prepared_json`, with JSON.stringify of a PreparedSubscription.
  const draft = row.preparedJson === null ? undefined : (JSON.parse(row.preparedJson) as PreparedSubscription)
  if (draft === undefined || draft.delegationHash !== body.value.delegationHash.toLowerCase())
    return apiError('subscription_unknown', 'Prepare the subscription again; this one is not known.', 409)
  let signed: SignedSubscription
  try {
    const chain = chainByKey('base', call.env.WALLET_LIVE === '1')
    signed = await confirmSubscription(chain, draft, hex(call.owner.ownerAddress), hex(body.value.signature))
  } catch (error) {
    // expected: the delegation code's refusal (`code: message`) is the owner's 400; nothing was kept.
    return refusal(error)
  }
  const activated = await call.subscriptions.activate({
    id: row.id,
    owner: call.owner.userId,
    ownerAddress: call.owner.ownerAddress,
    signedJson: JSON.stringify(signed),
    delegationHash: signed.delegationHash,
    startsAt: Math.floor(Date.parse(signed.startsAt) / 1000),
    expiresAt: Math.floor(Date.parse(signed.expiresAt) / 1000),
    now: nowS(),
  })
  if (!activated)
    return apiError('not_pending', 'This request is no longer waiting to be signed.', 409, 'Ask for a new one.')
  const updated = await ownRow(call)
  return updated instanceof Response ? updated : json(viewOf(updated, nowS()))
}

/** Base's node and bundler for the owner's own operation; UserOperations run on mainnet only. */
const ownerChain = (call: ApiCall) => {
  const access = chainAccess(call.env)
  const bundler = access.bundlerFor?.('base')
  if (!access.live || bundler === undefined) return undefined
  return { chain: chainByKey('base', true), node: access.rpcFor('base'), bundler }
}

/**
 * `POST /api/subscriptions/:id/revoke/prepare`: the owner's cancellation as a UserOperation from their own account,
 * `disableDelegation` of the signed subscription, its gas paid in their USDC. Kept on the subscription for five
 * minutes; the page rebuilds the call and checks the operation before the owner signs it.
 */
export async function revokePrepare(call: ApiCall): Promise<Response> {
  const row = await ownRow(call)
  if (row instanceof Response) return row
  const signed = signedOf(row)
  if (statusAt(row, nowS()) !== 'active' || signed === undefined)
    return apiError('not_active', 'This subscription is not active.', 409)
  const access = ownerChain(call)
  if (access === undefined)
    return apiError('mainnet_only', 'Cancelling runs on mainnet only; this wallet is on testnets.', 409)
  const { chain, node, bundler } = access
  try {
    const op = await prepared(
      () =>
        prepareUserOp({
          chain,
          node,
          bundler,
          sender: call.owner.ownerAddress,
          calls: [revokeCall(chain, signed.delegation)],
          feeCeiling: UPGRADE_FEE_CEILINGS.base,
        }),
      chain,
    )
    const now = Date.now()
    const expiresAt = new Date(now + REVOKE_TTL_MS).toISOString()
    const revokeId = `revoke:${row.id}:${crypto.randomUUID()}`
    const pending = { upgradeId: revokeId, chain: 'base' as const, prepared: op, createdAt: iso(nowS()), expiresAt }
    await call.subscriptions.putRevoke(row.id, call.owner.userId, encodePendingUpgrade(pending))
    const draft: RevokeDraft = {
      revokeId,
      typedData: typedDataOf(op, chain),
      maxFeeUsdc: formatUnits(op.feeBound, 6),
      expiresAt,
    }
    return json(draft)
  } catch (error) {
    // expected: a rail's refusal is the owner's error envelope, and a chain or bundler that did not answer a 502 to
    // retry; nothing was signed.
    if (error instanceof WalletFailure) return failureResponse(error)
    return apiError('rail_unavailable', 'The chain or the bundler did not answer; nothing was sent.', 502, 'Try again.')
  }
}

/** Sends the owner's signed cancellation; a refusal sent nothing, no answer may have sent it. */
const sendRevoke = async (
  access: NonNullable<ReturnType<typeof ownerChain>>,
  pending: NonNullable<ReturnType<typeof decodePendingUpgrade>>,
  signature: string,
): Promise<SubmittedUserOp | Response> => {
  try {
    return await submitUserOp({ chain: access.chain, bundler: access.bundler, prepared: pending.prepared, signature })
  } catch (error) {
    if (!(error instanceof TransferError)) throw error
    if (error.uncertain) return apiError('revoke_uncertain', error.message.slice(0, 300), 502, 'Check again shortly.')
    return apiError('revoke_failed', error.message.slice(0, 300), 409, 'Prepare it again.')
  }
}

/**
 * `POST /api/subscriptions/:id/revoke`: sends the owner's signed cancellation. `revoked` once the chain shows the
 * delegation disabled; `submitted` while it is in flight (the collector reads the chain before every collection).
 */
export async function revokeConfirm(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, RevokeConfirm)
  if (!body.ok) return body.response
  const row = await ownRow(call)
  if (row instanceof Response) return row
  const pending = row.revokeJson === null ? undefined : decodePendingUpgrade(row.revokeJson)
  const signed = signedOf(row)
  const access = ownerChain(call)
  if (
    pending === undefined ||
    signed === undefined ||
    access === undefined ||
    pending.upgradeId !== body.value.revokeId ||
    Date.parse(pending.expiresAt) <= Date.now()
  )
    return apiError('revoke_unknown', 'This cancellation is not known or has expired.', 409, 'Prepare it again.')
  const sent = await sendRevoke(access, pending, body.value.signature)
  if (sent instanceof Response) return sent
  if (sent.status === 'reverted') return apiError('revoke_failed', 'The cancellation reverted.', 409, 'Try again.')
  const disabled = await delegationDisabled(access.node, access.chain.delegation.manager, signed.delegationHash).catch(
    // expected: a node one block behind reads as not yet; the subscription stays active until the chain shows it.
    () => false,
  )
  if (disabled) await call.subscriptions.markRevoked(row.id, nowS())
  const fresh = await ownRow(call)
  if (fresh instanceof Response) return fresh
  const result: RevokeResult = {
    status: disabled ? 'revoked' : 'submitted',
    subscription: viewOf(fresh, nowS()),
    ...(sent.txHash === undefined ? {} : { explorerUrl: `${access.chain.explorerUrl}/tx/${sent.txHash}` }),
  }
  return json(result)
}
