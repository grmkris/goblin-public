import { formatUnits, parseUnits } from '@goblin/wallet/amounts'
import { AGENT_GAS_CEILINGS, erc20Balance } from '@goblin/wallet/balances'
import {
  type BridgeResult,
  executeBridge,
  FLOAT_LOW,
  FLOAT_MAX_BRIDGE,
  type FloatDecision,
  type FrozenBridge,
  planRefill,
  quoteBridge,
  type RelayDelivery,
  relayDelivery,
} from '@goblin/wallet/bridge'
import { chainByKey } from '@goblin/wallet/chains'
import { type Operation, type Payment, type Terms, termsHash } from '@goblin/wallet/contract'
import type { LedgerApi } from '../ledger/client.ts'
import type { PayOutcome } from '../services/rails.ts'
import type { RailsDeps } from './deps.ts'
import { agentRoute, outcomeOfError, sentPayment } from './transfer.ts'

/**
 * The Tempo float (ADR 0051): the agent's USDC.e on Tempo, which paid inference and MPP services are paid from, kept
 * topped up from the owner's Base allowance. A run reads the float and what Base can release, decides, claims the
 * owner's single flight in the ledger, then bridges Base USDC to the agent's own Tempo address through Relay as one
 * UserOperation that redeems the shortfall and its gas from the allowance. Mainnet only.
 */

/** How a refused MPP charge's reason starts when a refill is on its way; `pay_challenge` adds when to try again. */
export const REFILLING = 'Refilling from your Base allowance; try again in about a minute.'
/**
 * When a payment refused for funds should be tried again: the alarm starts at once, the Base UserOperation is prepared,
 * signed and mined in 10 to 20 seconds, and Relay fills Base to Tempo in about two (its quote says 1 s).
 */
export const REFILL_RETRY_AFTER_SECONDS = 60
/** After an MPP payment leaves the float low, the check waits until the service has redeemed it (about 25 s). */
const AFTER_PAYMENT_MS = 30_000
const OPERATION_TTL_MS = 10 * 60_000
const DECIMALS = 6
const RELAY_REFERENCE = 'relay:'

const nowOf = (deps: RailsDeps): Date => (deps.now ?? (() => new Date()))()

/** What a run reads before it decides: the float on Tempo, and what the Base side can release. */
export interface FloatReading {
  readonly agent: string
  readonly held: bigint
  readonly allowance: bigint
  readonly owner: bigint
  readonly agentBase: bigint
}

/** Why nothing on Base can refill the float. */
export type FloatUnsourced = 'no_agent' | 'no_allowance' | 'allowance_expired'

/** Reads the float and its source; a chain that does not answer throws (the run tries again later). */
export const readFloat = async (deps: RailsDeps): Promise<FloatReading | { readonly unsourced: FloatUnsourced }> => {
  const profile = await deps.profile()
  const agent = deps.signer?.address ?? profile.agentAddress
  const owner = profile.ownerAddress
  if (agent === undefined || owner === undefined) return { unsourced: 'no_agent' }
  const stored = (await deps.allowances?.())?.find((entry) => entry.chain === 'base')
  const topUp = await deps.topUp?.('base')
  if (stored === undefined || topUp === undefined) return { unsourced: 'no_allowance' }
  if (Date.parse(stored.expiresAt) <= nowOf(deps).getTime()) return { unsourced: 'allowance_expired' }
  const base = chainByKey('base', deps.live).usdc.address
  const [held, allowance, ownerBase, agentBase] = await Promise.all([
    erc20Balance(deps.rpcFor('tempo'), chainByKey('tempo', deps.live).usdc.address, agent),
    topUp.available(),
    erc20Balance(deps.rpcFor('base'), base, owner),
    erc20Balance(deps.rpcFor('base'), base, agent),
  ])
  return { agent, held, allowance, owner: ownerBase, agentBase }
}

/** The decision for a reading: the gas ceiling on Base is kept back, and one bridge never passes the policy's cap. */
export const planFloat = (reading: FloatReading, need?: bigint): FloatDecision =>
  planRefill({
    held: reading.held,
    ...(need === undefined ? {} : { need }),
    allowance: reading.allowance,
    owner: reading.owner,
    agent: reading.agentBase,
    feeMargin: AGENT_GAS_CEILINGS.base,
    maxBridge: FLOAT_MAX_BRIDGE,
  })

const dollars = (units: bigint): string => {
  const cents = (units + 5_000n) / 10_000n
  return `$${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`
}

/** The refill's terms: Base USDC at face value, to the agent's own address (on Tempo, through Relay). */
const floatTerms = (deps: RailsDeps, agent: string, amount: bigint): Terms => {
  const usdc = chainByKey('base', deps.live).usdc
  const decimal = formatUnits(amount, DECIMALS)
  return {
    kind: 'bridge',
    chain: 'base',
    rail: 'relay',
    subject: `Moved ${dollars(amount)} to Tempo for paid inference`,
    token: { symbol: usdc.symbol, address: usdc.address, decimals: usdc.decimals },
    amount: decimal,
    amountUsd: decimal,
    recipient: agent,
    expiresAt: new Date(nowOf(deps).getTime() + OPERATION_TTL_MS).toISOString(),
  }
}

const refillOutcome = (deps: RailsDeps, bridge: FrozenBridge, result: BridgeResult): PayOutcome => {
  const payment: Payment = { ...sentPayment('relay', result), reference: `${RELAY_REFERENCE}${bridge.requestId}` }
  if (result.status === 'pending')
    return { outcome: 'uncertain', reason: 'The refill was sent but has not confirmed yet.', payment }
  if (result.status === 'reverted') return { outcome: 'failed', reason: 'The chain rejected the refill.' }
  return {
    outcome: 'settled',
    payment: { ...payment, settledAt: nowOf(deps).toISOString() },
    delivery: { status: result.delivery, detail: `Relay: ${result.detail}` },
  }
}

/**
 * Quotes and sends one claimed refill: Relay's quote for the operation's amount to the agent's own Tempo address, then
 * the deposit as a UserOperation that redeems what the agent lacks from the allowance. Never throws.
 */
export const sendRefill = async (
  deps: RailsDeps,
  operation: Operation,
  onSubmitted: (userOpHash: string) => Promise<void>,
): Promise<PayOutcome> => {
  const { signer } = deps
  if (signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  const io = {
    ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }
  try {
    const bridge = await quoteBridge({
      from: 'base',
      to: 'tempo',
      token: 'USDC',
      amount: operation.terms.amount,
      agent: signer.address,
      recipient: signer.address,
      ...io,
    })
    const route = await agentRoute(deps, 'base', signer)
    const result = await executeBridge({ ...route, bridge, operationKey: operation.id, onSubmitted, ...io })
    return refillOutcome(deps, bridge, result)
  } catch (error) {
    // expected: a refusal before signing is failed; anything after it may have moved money and is uncertain.
    return outcomeOfError(error)
  }
}

/** What a run asks of the ledger: its run bookkeeping, the claim, and the operation's moves. */
export type FloatLedger = Pick<
  LedgerApi,
  'startFloatRun' | 'claimFloat' | 'endFloatRun' | 'submitted' | 'settle' | 'fail' | 'uncertain'
>

/** The run's reads and sends; tests replace them. */
export interface FloatIo {
  readonly read: typeof readFloat
  readonly send: typeof sendRefill
  readonly delivery: (deps: RailsDeps, requestId: string) => Promise<RelayDelivery>
}

const RAILS_IO: FloatIo = {
  read: readFloat,
  send: sendRefill,
  delivery: async (deps, requestId) =>
    (await relayDelivery(requestId, { fetchFn: deps.fetchFn, attempts: 1 })).delivery,
}

const record = async (ledger: FloatLedger, id: string, outcome: PayOutcome): Promise<void> => {
  if (outcome.outcome === 'failed') await ledger.fail(id, outcome.reason)
  else if (outcome.outcome === 'uncertain')
    await (outcome.payment === undefined
      ? ledger.uncertain(id, outcome.reason)
      : ledger.uncertain(id, outcome.reason, outcome.payment))
  else
    await ledger.settle(id, {
      payment: outcome.payment,
      ...(outcome.delivery === undefined ? {} : { delivery: outcome.delivery }),
      delivered: outcome.delivery?.status === 'delivered',
    })
}

/**
 * A refill whose deposit confirmed before Relay reported its arrival holds the flight; Relay is asked once more, and
 * an arrival settles it and frees the flight.
 */
const arrived = async (deps: RailsDeps, ledger: FloatLedger, io: FloatIo, operation: Operation): Promise<boolean> => {
  const { payment } = operation
  const reference = payment?.reference
  if (operation.status !== 'confirmed' || payment === undefined || reference?.startsWith(RELAY_REFERENCE) !== true)
    return false
  // expected: Relay not answering leaves the refill in flight until its lease ends.
  const delivery = await io.delivery(deps, reference.slice(RELAY_REFERENCE.length)).catch(() => 'pending' as const)
  if (delivery !== 'delivered') return false
  await ledger.settle(operation.id, {
    payment,
    delivery: { status: delivery, detail: 'Relay: success' },
    delivered: true,
  })
  return true
}

/** One attempt: read, decide, claim, send, record. `failed` when the chains did not answer or the refill failed. */
const attempt = async (
  deps: RailsDeps,
  ledger: FloatLedger,
  io: FloatIo,
  need: string | undefined,
): Promise<'sent' | 'failed' | 'idle'> => {
  const reading = await io.read(deps).catch(
    // expected: a chain that did not answer is read again on the run's retry.
    () => undefined,
  )
  if (reading === undefined) return 'failed'
  if ('unsourced' in reading) return 'idle'
  const decision = planFloat(reading, need === undefined ? undefined : parseUnits(need, DECIMALS))
  if (decision.kind === 'skip') return 'idle'
  const terms = floatTerms(deps, reading.agent, decision.amount)
  const claim = await ledger.claimFloat({ terms, termsHash: await termsHash(terms) })
  if (claim.kind !== 'claimed') return 'idle'
  const { id } = claim.operation
  const outcome = await io.send(deps, claim.operation, async (userOpHash) => {
    await ledger.submitted(id, { rail: 'relay', userOpHash })
  })
  await record(ledger, id, outcome)
  return outcome.outcome === 'failed' ? 'failed' : 'sent'
}

/**
 * One run of the owner's float alarm. On testnets it does nothing. Paused refills, and a refill already in flight,
 * leave it at that. Returns when to run again after a failure (bounded by the ledger).
 */
export const runFloat = async (
  deps: RailsDeps,
  ledger: FloatLedger,
  io: FloatIo = RAILS_IO,
): Promise<{ retryInMs?: number }> => {
  if (!deps.live) return {}
  const start = await ledger.startFloatRun()
  if (start.paused) return {}
  if (start.inFlight !== undefined && !(await arrived(deps, ledger, io, start.inFlight))) return {}
  return ledger.endFloatRun(await attempt(deps, ledger, io, start.need))
}

/** After an MPP payment that leaves the float under $1, asks for a check once the service has redeemed it. */
export const afterPayment = async (deps: RailsDeps, held: bigint | undefined, spent: bigint): Promise<void> => {
  if (deps.float === undefined || !deps.live || held === undefined || held - spent >= FLOAT_LOW) return
  // expected: a check that cannot be asked for now is asked for by the next payment; this payment stands.
  await deps.float.schedule({ delayMs: AFTER_PAYMENT_MS }).catch(() => undefined)
}

/**
 * For an MPP charge refused for want of USDC.e: whether a refill is on its way, either in flight or one the alarm now
 * sends because Base can release it. Asks the alarm in both cases, carrying the charge so the refill covers it.
 */
export const refillForShort = async (deps: RailsDeps, need: bigint): Promise<boolean> => {
  const hooks = deps.float
  if (hooks === undefined || !deps.live) return false
  try {
    const state = await hooks.state()
    if (state.pausedUntil !== undefined) return false
    const ask = { delayMs: 0, need: formatUnits(need, DECIMALS) }
    if (!state.refilling) {
      const reading = await readFloat(deps)
      if ('unsourced' in reading || planFloat(reading, need).kind !== 'refill') return false
    }
    await hooks.schedule(ask)
    return true
  } catch {
    // expected: a refill that cannot be checked or asked for leaves the plain refusal; nothing was signed either way.
    return false
  }
}
