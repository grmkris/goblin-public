import { parseUnits } from '@goblin/wallet/amounts'
import {
  delegationDisabled,
  erc20Balance,
  getAllowanceState,
  type JsonRpc,
  sendCalls,
  TransferError,
  type WaitOptions,
} from '@goblin/wallet/balances'
import { userOpReceipt } from '@goblin/wallet/bundler'
import { chainByKey } from '@goblin/wallet/chains'
import type { AgentSigner, Collection, CollectReason, CollectRequest } from '@goblin/wallet/contract'
import { allowanceRedeemCalldata, periodAt, periodCount, type SignedSubscription } from '@goblin/wallet/delegation'
import type { SubscriptionApi } from '../oauth/durable.ts'
import { type PaidCollection, type SubscriptionRow, statusAt } from './store.ts'

/** What a collection needs besides the store: Base's node, Pimlico, the collector's signer and the clock. */
export interface CollectDeps {
  readonly live: boolean
  readonly rpc: JsonRpc
  readonly bundler: JsonRpc | undefined
  readonly collector: AgentSigner | undefined
  /** Epoch milliseconds. */
  readonly now: () => number
  readonly wait?: WaitOptions | undefined
}

const failed = (reason: CollectReason): Collection => ({ status: 'failed', reason })
const iso = (seconds: number): string => new Date(seconds * 1000).toISOString()

/** The signed subscription the row keeps; undefined when it holds none. */
const signedOf = (row: SubscriptionRow): SignedSubscription | undefined => {
  if (row.signedJson === null) return undefined
  // SAFETY: only the owner API's confirm writes `signed_json`, with JSON.stringify of a SignedSubscription.
  return JSON.parse(row.signedJson) as SignedSubscription
}

/**
 * Why period `period` of `row` cannot be collected now, or nothing when it can. Only a period that has not started is
 * `not_due`: a day pass's period is due all through its UTC day.
 */
const refusalOf = (row: SubscriptionRow, period: number, nowMs: number): CollectReason | undefined => {
  const status = statusAt(row, Math.floor(nowMs / 1000))
  if (status === 'revoked' || status === 'expired') return status
  if (status === 'pending' || row.startsAt === null) return 'not_due'
  const current = periodAt(iso(row.startsAt), row, nowMs)
  if (period > current) return 'not_due'
  // A period that has ended can no longer be collected: the enforcer counts only the current one.
  if (period < current || period > periodCount(row)) return 'expired'
  return undefined
}

/** A read before anything is signed: a chain that does not answer means nothing was sent, and the merchant retries. */
const read = <A>(what: () => Promise<A>): Promise<A | undefined> =>
  what().catch(
    // expected: an unanswered read refuses the collection as `chain`; nothing was signed.
    () => undefined,
  )

/** What the chain says before the collector sends: revoked, already paid this period, or the owner short. */
const chainCheck = async (
  row: SubscriptionRow,
  signed: SignedSubscription,
  deps: CollectDeps,
): Promise<'revoked' | 'paid' | 'insufficient_funds' | 'chain' | 'ok'> => {
  const chain = chainByKey('base', deps.live)
  const amount = parseUnits(row.amountUsd, chain.usdc.decimals)
  const enforcer = chain.delegation.enforcers.erc20PeriodTransfer.toLowerCase()
  const terms = signed.delegation.caveats.find((item) => item.enforcer.toLowerCase() === enforcer)?.terms
  const [disabled, allowance, held] = await Promise.all([
    read(() => delegationDisabled(deps.rpc, chain.delegation.manager, signed.delegationHash)),
    terms === undefined
      ? undefined
      : read(() =>
          getAllowanceState({
            chain: 'base',
            delegationHash: signed.delegationHash,
            terms,
            rpcFor: () => deps.rpc,
            live: deps.live,
          }),
        ),
    read(() => erc20Balance(deps.rpc, chain.usdc.address, signed.delegation.delegator)),
  ])
  if (disabled === true) return 'revoked'
  if (disabled === undefined || allowance === undefined || held === undefined) return 'chain'
  // Only the collector redeems this delegation: a period whose allowance is spent was paid by an earlier attempt.
  if (allowance.available < amount) return 'paid'
  return held < amount ? 'insufficient_funds' : 'ok'
}

/** The redemption as one UserOperation from the collector: the owner's period payment, into the collector's wallet. */
const send = async (
  row: SubscriptionRow,
  signed: SignedSubscription,
  deps: CollectDeps & { readonly collector: AgentSigner; readonly bundler: JsonRpc },
  key: string,
  onSubmitted: (userOpHash: string) => Promise<void>,
): Promise<Collection> => {
  const chain = chainByKey('base', deps.live)
  const amount = parseUnits(row.amountUsd, chain.usdc.decimals)
  try {
    const sent = await sendCalls(
      {
        live: deps.live,
        chain: 'base',
        agent: deps.collector,
        rpc: deps.rpc,
        bundler: deps.bundler,
        wait: deps.wait,
        onSubmitted,
      },
      {
        key,
        calls: [
          {
            target: chain.delegation.manager,
            value: 0n,
            callData: allowanceRedeemCalldata(chain, signed.delegation, amount),
          },
        ],
      },
    )
    if (sent.status === 'pending') return { status: 'pending', userOpHash: sent.userOpHash }
    if (sent.status === 'reverted') return { status: 'failed', reason: 'chain', userOpHash: sent.userOpHash }
    return {
      status: 'paid',
      userOpHash: sent.userOpHash,
      ...(sent.txHash === undefined ? {} : { txHash: sent.txHash }),
    }
  } catch (error) {
    if (!(error instanceof TransferError)) throw error
    // An answer that may have gone out is pending; any other refusal sent nothing (the collector's float among them).
    return error.uncertain ? { status: 'pending' } : failed('chain')
  }
}

/** A submitted attempt's outcome, from the bundler; still `pending` while it has no receipt. */
const checked = async (bundler: JsonRpc, userOpHash: string): Promise<Collection> => {
  const found = await userOpReceipt(bundler, userOpHash).catch(
    // expected: a bundler that does not answer leaves the attempt pending; the merchant asks again.
    () => undefined,
  )
  if (found === undefined) return { status: 'pending', userOpHash }
  return found.status === 'success'
    ? { status: 'paid', userOpHash, ...(found.txHash === undefined ? {} : { txHash: found.txHash }) }
    : { status: 'failed', reason: 'chain', userOpHash }
}

/** The answer kept for the period, with when it was paid. */
const recorded = (
  store: SubscriptionApi,
  row: SubscriptionRow,
  period: number,
  outcome: Collection,
  nowMs: number,
): Promise<Collection> => {
  const now = Math.floor(nowMs / 1000)
  return store
    .finishCollection({ subscriptionId: row.id, period, ...outcome, now })
    .then(() => (outcome.status === 'paid' ? { ...outcome, paidAt: iso(now) } : outcome))
}

/** A paid period's recorded payment, as the merchant reads it. */
const paidAnswer = (start: PaidCollection): Collection => ({
  status: 'paid',
  ...(start.userOpHash === null ? {} : { userOpHash: start.userOpHash }),
  ...(start.txHash === null ? {} : { txHash: start.txHash }),
  paidAt: iso(start.at),
})

type Ready = CollectDeps & { readonly collector: AgentSigner; readonly bundler: JsonRpc }

/** One attempt that holds its period: the chain read first, then the redemption, each outcome recorded. */
const attempt = async (
  store: SubscriptionApi,
  deps: Ready,
  row: SubscriptionRow,
  signed: SignedSubscription,
  { period, attemptNumber }: { readonly period: number; readonly attemptNumber: number },
): Promise<Collection> => {
  const verdict = await chainCheck(row, signed, deps)
  if (verdict === 'revoked') await store.markRevoked(row.id, Math.floor(deps.now() / 1000))
  if (verdict === 'paid') return recorded(store, row, period, { status: 'paid' }, deps.now())
  if (verdict !== 'ok') return recorded(store, row, period, failed(verdict), deps.now())
  const submitted = (userOpHash: string) =>
    store.finishCollection({
      subscriptionId: row.id,
      period,
      status: 'pending',
      userOpHash,
      now: Math.floor(deps.now() / 1000),
    })
  const key = `collect:${row.id}:${String(period)}:${String(attemptNumber)}`
  return recorded(store, row, period, await send(row, signed, deps, key, submitted), deps.now())
}

/** A submitted attempt settled from its receipt and recorded; still `pending` while the bundler has none. */
const settle = async (
  store: SubscriptionApi,
  deps: CollectDeps & { readonly bundler: JsonRpc },
  row: SubscriptionRow,
  period: number,
  userOpHash: string,
): Promise<Collection> => {
  const outcome = await checked(deps.bundler, userOpHash)
  return outcome.status === 'pending' ? outcome : recorded(store, row, period, outcome, deps.now())
}

/**
 * Collects period `request.period` of a subscription (ADR 0054): at most once per period, whatever the operation id. A
 * paid period answers its payment whenever it is asked, even once it ended or the subscription was revoked; a
 * submitted one its receipt; otherwise the chain is read first (revoked, already paid, the owner short: nothing is
 * signed then), and the collector redeems the period's amount in one UserOperation whose gas it pays in USDC from its
 * own float. The chain caps the redemption at one amount a period, whatever this does.
 */
export async function collect(
  store: SubscriptionApi,
  deps: CollectDeps,
  row: SubscriptionRow,
  request: CollectRequest,
): Promise<Collection> {
  const nowMs = deps.now()
  const known = await store.knownCollection(row.id, request.period, Math.floor(nowMs / 1000))
  if (known?.kind === 'paid') return paidAnswer(known)
  const refusal = refusalOf(row, request.period, nowMs)
  const { collector, bundler } = deps
  if (refusal !== undefined)
    // An attempt submitted before the period ended may still land: its receipt decides, not the clock.
    return known === undefined || bundler === undefined
      ? failed(refusal)
      : settle(store, { ...deps, bundler }, row, request.period, known.userOpHash)
  const signed = signedOf(row)
  if (signed === undefined || collector === undefined || bundler === undefined) return failed('chain')
  const start = await store.beginCollection({
    subscriptionId: row.id,
    period: request.period,
    operationId: request.operationId,
    now: Math.floor(nowMs / 1000),
  })
  if (start.kind === 'busy') return { status: 'pending' }
  if (start.kind === 'paid') return paidAnswer(start)
  if (start.kind === 'go')
    return attempt(store, { ...deps, collector, bundler }, row, signed, {
      period: request.period,
      attemptNumber: start.attempt,
    })
  return settle(store, { ...deps, bundler }, row, request.period, start.userOpHash)
}
