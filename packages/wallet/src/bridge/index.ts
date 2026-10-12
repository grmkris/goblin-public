/**
 * Bridges with Relay (`api.relay.link/quote/v2`, keyless): Base, Ethereum or Arbitrum USDC to USDC on Base, Ethereum,
 * Arbitrum or Tempo (USDC.e). A quote is frozen; execution runs exactly the quoted steps. Every step is decoded and
 * checked when quoted and again before it is signed: from the agent, on the origin chain, zero native value, at most
 * one USDC `approve` of exactly the amount to Relay's depository, then one `depositErc20` of exactly that amount of
 * origin USDC by the agent into that depository. The destination recipient is bound by Relay's order id, which the
 * wallet cannot decode: it is checked against the quote's `details` (recipient, currencies, chains, amount in). A
 * quote without a USD valuation is refused. Then Relay is polled until the funds land or are refunded.
 */
import * as Data from 'effect/Data'
import * as Schema from 'effect/Schema'
import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem'
import { formatUnits, parseUnits } from '../amounts/index.ts'
import { erc20Balance } from '../balances/erc20.ts'
import { toAddress, toHex } from '../balances/hex.ts'
import { field, type JsonRpc, type WaitOptions } from '../balances/rpc.ts'
import { sendSimulated, TransferError, type EvmChain } from '../balances/send.ts'
import { ensureUsdc, type TopUp } from '../balances/transfer.ts'
import { ARBITRUM, BASE, ETHEREUM, TEMPO, type Chain } from '../chains/index.ts'
import type { AgentSigner, ChainKey } from '../contract/index.ts'

/** Relay's depository: the same address on every chain Relay serves. */
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const API = 'https://api.relay.link'

const CHAINS: Readonly<Record<ChainKey, Chain>> = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM, tempo: TEMPO }

export type BridgeFailure = 'unsupported' | 'bad_quote' | 'expired' | 'insufficient_funds'

export class BridgeError extends Data.TaggedError('BridgeError')<{
  readonly code: BridgeFailure
  readonly message: string
}> {
  constructor(code: BridgeFailure, message: string) {
    super({ code, message })
  }
}

const BridgeStepSchema = Schema.Struct({
  id: Schema.Literals(['approve', 'deposit']),
  to: Schema.String,
  data: Schema.String,
})
export type BridgeStep = typeof BridgeStepSchema.Type

/** A frozen bridge quote. Strings only, so it is JSON-safe for the ledger; `decodeFrozenBridge` reads it back. */
export const FrozenBridgeSchema = Schema.Struct({
  from: Schema.Literals(['base', 'ethereum', 'arbitrum']),
  to: Schema.Literals(['base', 'ethereum', 'arbitrum', 'tempo']),
  requestId: Schema.String,
  steps: Schema.Array(BridgeStepSchema),
  /** USDC base units sent on the origin chain. */
  amountIn: Schema.String,
  amountOut: Schema.String,
  amountOutMin: Schema.String,
  amountInUsd: Schema.String,
  feesUsd: Schema.String,
  timeEstimateSeconds: Schema.Int,
  /** The destination-chain recipient. */
  recipient: Schema.String,
  agent: Schema.String,
  quotedAt: Schema.String,
  expiresAt: Schema.String,
})
export type FrozenBridge = typeof FrozenBridgeSchema.Type

export const decodeFrozenBridge = Schema.decodeUnknownSync(FrozenBridgeSchema)

export interface BridgeQuoteInput {
  readonly from: ChainKey
  readonly to: ChainKey
  readonly token: string
  /** Decimal USDC amount. */
  readonly amount: string
  readonly agent: string
  /** Destination recipient; defaults to the agent. */
  readonly recipient?: string
  /** Slippage in basis points; default 50, capped at 100. */
  readonly slippageBps?: number
  readonly fetchFn?: typeof fetch
  readonly now?: () => Date
  readonly ttlSeconds?: number
}

const isEvmOrigin = (chain: ChainKey): chain is EvmChain => chain !== 'tempo'

/** A USD decimal from Relay cut to six decimals; a missing or malformed value is refused, never read as zero. */
const usd = (value: unknown, what: string): string => {
  const text = typeof value === 'string' ? value : ''
  const [whole = '', fraction = ''] = text.split('.')
  if (!/^\d+$/u.test(whole) || !/^\d*$/u.test(fraction))
    throw new BridgeError('bad_quote', `The quote has no USD value for ${what}.`)
  return `${whole}${fraction === '' ? '' : `.${fraction.slice(0, 6)}`}`
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new BridgeError('bad_quote', `The quote has no ${what}.`)
  return value
}

const APPROVE = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const DEPOSIT = parseAbi(['function depositErc20(address depositor, address token, uint256 amount, bytes32 id)'])

const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** Why a step's calldata is not the exact approval or deposit the wallet runs, or undefined when it is. */
const stepMismatch = (step: BridgeStep, origin: Chain, agent: string, amountIn: bigint): string | undefined => {
  try {
    if (step.id === 'approve') {
      if (!same(step.to, origin.usdc.address)) return 'The approval is not for USDC.'
      const [spender, amount] = decodeFunctionData({ abi: APPROVE, data: toHex(step.data) }).args
      return same(spender, RELAY_DEPOSITORY) && amount === amountIn
        ? undefined
        : 'The approval is not the exact amount to Relay.'
    }
    if (!same(step.to, RELAY_DEPOSITORY)) return "The deposit is not into Relay's depository."
    const [depositor, token, amount] = decodeFunctionData({ abi: DEPOSIT, data: toHex(step.data) }).args
    return same(depositor, agent) && same(token, origin.usdc.address) && amount === amountIn
      ? undefined
      : 'The deposit is not the quoted amount of USDC from the agent.'
  } catch {
    // expected: calldata that does not decode as approve/depositErc20 is refused by the caller.
    return `The ${step.id} step calls a function the wallet does not run.`
  }
}

/** At most one approval, then exactly one deposit, each exactly the quoted amount. */
const checkSteps = (steps: readonly BridgeStep[], origin: Chain, agent: string, amountIn: bigint): void => {
  const ids = steps.map((step) => step.id).join(',')
  if (ids !== 'deposit' && ids !== 'approve,deposit')
    throw new BridgeError('bad_quote', 'The quote does not approve then deposit.')
  for (const step of steps) {
    const mismatch = stepMismatch(step, origin, agent, amountIn)
    if (mismatch !== undefined) throw new BridgeError('bad_quote', mismatch)
  }
}

/** Relay's `details` must restate the request: who receives, which currencies on which chains, and the amount in. */
const checkDetails = (details: unknown, input: BridgeQuoteInput, recipient: string, amountIn: bigint): void => {
  const origin = CHAINS[input.from]
  const destination = CHAINS[input.to]
  const currencyIn = field(details, 'currencyIn')
  const currencyOut = field(details, 'currencyOut')
  if (!same(field(details, 'recipient'), recipient)) throw new BridgeError('bad_quote', 'The quote pays someone else.')
  const matches =
    same(field(field(currencyIn, 'currency'), 'address'), origin.usdc.address) &&
    field(field(currencyIn, 'currency'), 'chainId') === origin.id &&
    field(currencyIn, 'amount') === amountIn.toString() &&
    same(field(field(currencyOut, 'currency'), 'address'), destination.usdc.address) &&
    field(field(currencyOut, 'currency'), 'chainId') === destination.id
  if (!matches) throw new BridgeError('bad_quote', 'The quote does not restate the requested bridge.')
}

const readStep = (item: unknown, id: string, input: BridgeQuoteInput): BridgeStep => {
  const data = field(item, 'data')
  const to = text(field(data, 'to'), 'step target')
  const calldata = text(field(data, 'data'), 'step calldata')
  if (!same(field(data, 'from'), input.agent) || field(data, 'chainId') !== CHAINS[input.from].id)
    throw new BridgeError('bad_quote', 'A step is not for the agent wallet on the origin chain.')
  const value = field(data, 'value')
  if (value !== undefined && !['0', '0x0', ''].includes(text(value, 'step value')))
    throw new BridgeError('bad_quote', 'A step sends native value.')
  if (id !== 'approve' && id !== 'deposit')
    throw new BridgeError('bad_quote', `The quote has a step the wallet does not run (${id}).`)
  return { id, to, data: calldata }
}

const stepsOf = (raw: unknown, input: BridgeQuoteInput, amountIn: bigint): BridgeStep[] => {
  const steps = field(raw, 'steps')
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 2)
    throw new BridgeError('bad_quote', 'The quote has no runnable steps.')
  const read = steps.map((step: unknown) => {
    const items = field(step, 'items')
    if (field(step, 'kind') !== 'transaction' || !Array.isArray(items) || items.length !== 1)
      throw new BridgeError('bad_quote', 'A quote step is not a single transaction.')
    return readStep(items[0], text(field(step, 'id'), 'step id'), input)
  })
  checkSteps(read, CHAINS[input.from], input.agent, amountIn)
  return read
}

/** A fee Relay omits is zero; a fee it lists without a USD value is refused. */
const feeUsd = (fee: unknown, name: string): bigint =>
  fee === undefined ? 0n : parseUnits(usd(field(fee, 'amountUsd'), `the ${name} fee`), 6)

const feesUsd = (raw: unknown): string => {
  const fees = field(raw, 'fees')
  const parts = ['gas', 'relayer', 'app'].map((name) => feeUsd(field(fees, name), name))
  return formatUnits(
    parts.reduce((total, part) => total + part, 0n),
    6,
  )
}

/** Asks Relay for a USDC bridge quote and freezes it after checking every step. */
export const quoteBridge = async (input: BridgeQuoteInput): Promise<FrozenBridge> => {
  if (!isEvmOrigin(input.from)) throw new BridgeError('unsupported', 'Bridging out of Tempo is not supported yet.')
  if (input.from === input.to) throw new BridgeError('unsupported', 'Origin and destination are the same chain.')
  if (!['USDC', 'USDC.E'].includes(input.token.toUpperCase()))
    throw new BridgeError('unsupported', 'Only USDC bridges are supported.')
  const origin = CHAINS[input.from]
  const destination = CHAINS[input.to]
  const amountIn = parseUnits(input.amount, origin.usdc.decimals)
  const recipient = input.recipient ?? input.agent
  const response = await (input.fetchFn ?? fetch)(`${API}/quote/v2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: input.agent,
      originChainId: origin.id,
      originCurrency: origin.usdc.address,
      destinationChainId: destination.id,
      destinationCurrency: destination.usdc.address,
      amount: amountIn.toString(),
      tradeType: 'EXACT_INPUT',
      recipient,
      slippageTolerance: String(Math.min(input.slippageBps ?? 50, 100)),
    }),
  })
  if (!response.ok) throw new BridgeError('bad_quote', `Relay answered ${response.status}.`)
  const raw: unknown = await response.json()
  const details = field(raw, 'details')
  checkDetails(details, input, recipient, amountIn)
  const now = (input.now ?? (() => new Date()))()
  const out = field(details, 'currencyOut')
  return {
    from: input.from,
    to: input.to,
    requestId: text(field(raw, 'requestId'), 'request id'),
    steps: stepsOf(raw, input, amountIn),
    amountIn: amountIn.toString(),
    amountOut: text(field(out, 'amount'), 'amount out'),
    amountOutMin: text(field(out, 'minimumAmount'), 'minimum received'),
    amountInUsd: usd(field(field(details, 'currencyIn'), 'amountUsd'), 'the amount in'),
    feesUsd: feesUsd(raw),
    timeEstimateSeconds:
      typeof field(details, 'timeEstimate') === 'number' ? Number(field(details, 'timeEstimate')) : 60,
    recipient,
    agent: input.agent,
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.ttlSeconds ?? 120) * 1000).toISOString(),
  }
}

export type RelayDelivery = 'delivered' | 'pending' | 'failed'

export interface ExecuteBridgeInput {
  readonly bridge: FrozenBridge
  readonly agent: AgentSigner
  readonly rpc: JsonRpc
  readonly operationKey: string
  readonly wait?: WaitOptions
  readonly fetchFn?: typeof fetch
  readonly now?: () => Date
  /** The owner's allowance on the origin chain: the deposit's shortfall is redeemed before anything is signed. */
  readonly topUp?: TopUp | undefined
  /** Status polls after the deposit confirms; default 10 at 3 s. */
  readonly statusAttempts?: number
  readonly sleep?: (ms: number) => Promise<void>
}

export interface BridgeResult {
  /** The deposit transaction on the origin chain. */
  readonly txHash: string
  readonly explorerUrl: string
  readonly status: 'success' | 'reverted' | 'pending'
  readonly delivery: RelayDelivery
  readonly detail: string
  readonly destinationTxHashes: readonly string[]
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface RelayStatus {
  readonly status: string
  readonly txHashes: string[]
}

const readStatus = async (requestId: string, fetchFn: typeof fetch): Promise<RelayStatus> => {
  const response = await fetchFn(`${API}/intents/status/v3?requestId=${encodeURIComponent(requestId)}`)
  const body: unknown = response.ok ? await response.json() : undefined
  const status = field(body, 'status')
  const hashes = field(body, 'txHashes')
  return {
    status: typeof status === 'string' ? status : 'unknown',
    txHashes: Array.isArray(hashes) ? hashes.filter((hash): hash is string => typeof hash === 'string') : [],
  }
}

/** Polls Relay until the bridge lands (`delivered`), is refunded or fails (`failed`), or the polls run out (`pending`). */
export const relayDelivery = async (
  requestId: string,
  options: {
    fetchFn?: typeof fetch | undefined
    attempts?: number | undefined
    sleep?: ((ms: number) => Promise<void>) | undefined
  },
): Promise<{ delivery: RelayDelivery; detail: string; txHashes: string[] }> => {
  let detail = 'waiting'
  for (let attempt = 0; attempt < (options.attempts ?? 10); attempt += 1) {
    const current = await readStatus(requestId, options.fetchFn ?? fetch)
    detail = current.status
    if (detail === 'success') return { delivery: 'delivered', detail, txHashes: current.txHashes }
    if (detail === 'failure' || detail === 'refunded') return { delivery: 'failed', detail, txHashes: current.txHashes }
    await (options.sleep ?? realSleep)(3000)
  }
  return { delivery: 'pending', detail, txHashes: [] }
}

/** Refuses an expired quote or one that does not match this wallet; returns the origin chain. */
const assertRunnable = (input: ExecuteBridgeInput): Chain => {
  const { bridge } = input
  if ((input.now ?? (() => new Date()))().getTime() > Date.parse(bridge.expiresAt))
    throw new BridgeError('expired', 'The quote expired; ask for a new one.')
  const origin = CHAINS[bridge.from]
  if (!same(bridge.agent, input.agent.address) || !/^\d+$/u.test(bridge.amountIn))
    throw new BridgeError('bad_quote', 'The frozen quote does not match this wallet; ask for a new one.')
  checkSteps(bridge.steps, origin, bridge.agent, BigInt(bridge.amountIn))
  return origin
}

/**
 * The agent must hold the deposit before the approval is signed: an EVM origin's shortfall comes from the owner's
 * allowance, exactly as for a transfer; then the balance is checked so an empty wallet never signs an approval.
 */
const fundDeposit = async (input: ExecuteBridgeInput, origin: Chain): Promise<void> => {
  const { bridge } = input
  const amount = BigInt(bridge.amountIn)
  if (input.topUp !== undefined)
    await ensureUsdc({
      chain: bridge.from,
      amount,
      operationKey: input.operationKey,
      agent: input.agent,
      rpc: input.rpc,
      topUp: input.topUp,
      wait: input.wait,
    })
  if ((await erc20Balance(input.rpc, origin.usdc.address, input.agent.address)) < amount)
    throw new BridgeError(
      'insufficient_funds',
      `The agent wallet holds less ${origin.usdc.symbol} than the bridge sends.`,
    )
}

const ALLOWANCE = parseAbi(['function allowance(address owner, address spender) view returns (uint256)'])
const pauseFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Waits until the RPC shows the depository's fresh allowance: a load-balanced node behind the approval's block would
 * answer the deposit's simulation with a revert. Giving up is a plain failure; the deposit is not signed yet.
 */
const untilApproved = async (input: ExecuteBridgeInput, origin: Chain): Promise<void> => {
  const data = encodeFunctionData({
    abi: ALLOWANCE,
    functionName: 'allowance',
    args: [toAddress(input.agent.address), toAddress(RELAY_DEPOSITORY)],
  })
  for (let attempt = 0; attempt < (input.wait?.attempts ?? 10); attempt += 1) {
    // expected: an unanswered or unreadable read counts as not visible yet; the loop asks again.
    const raw = await input.rpc('eth_call', [{ to: origin.usdc.address, data }, 'latest']).catch(() => '0x')
    const shown = /^0x[0-9a-fA-F]{64}$/u.test(String(raw)) ? BigInt(String(raw)) : 0n
    if (shown >= BigInt(input.bridge.amountIn)) return
    await (input.wait?.sleep ?? pauseFor)(input.wait?.intervalMs ?? 1000)
  }
  throw new TransferError(
    'rpc_unavailable',
    'The approval landed but the chain did not show it in time; nothing was bridged. Try again.',
  )
}

/** Executes a frozen bridge: funding, the approval (if quoted), the deposit, then Relay's delivery status. */
export const executeBridge = async (input: ExecuteBridgeInput): Promise<BridgeResult> => {
  const { bridge } = input
  const origin = assertRunnable(input)
  await fundDeposit(input, origin)
  const context = { agent: input.agent, rpc: input.rpc, chain: bridge.from, wait: input.wait }
  let deposit: { hash: string; status: 'success' | 'reverted' | 'pending' } | undefined
  for (const step of bridge.steps) {
    const sent = await sendSimulated(context, {
      key: `${input.operationKey}:${step.id}`,
      to: step.to,
      data: toHex(step.data),
    })
    if (sent.status !== 'success' && step.id === 'approve')
      throw new TransferError(
        sent.status === 'pending' ? 'uncertain' : 'reverted',
        'The approval did not confirm.',
        sent.status === 'pending',
      )
    if (step.id === 'approve') await untilApproved(input, origin)
    if (step.id === 'deposit') deposit = sent
  }
  if (deposit === undefined) throw new BridgeError('bad_quote', 'The quote has no deposit step.')
  const explorerUrl = `${origin.explorerUrl}/tx/${deposit.hash}`
  if (deposit.status !== 'success') {
    return {
      txHash: deposit.hash,
      explorerUrl,
      status: deposit.status,
      delivery: 'pending',
      detail: deposit.status,
      destinationTxHashes: [],
    }
  }
  const landed = await relayDelivery(bridge.requestId, {
    fetchFn: input.fetchFn,
    attempts: input.statusAttempts,
    sleep: input.sleep,
  })
  return {
    txHash: deposit.hash,
    explorerUrl,
    status: 'success',
    delivery: landed.delivery,
    detail: landed.detail,
    destinationTxHashes: landed.txHashes,
  }
}

const NATIVE = '0x0000000000000000000000000000000000000000'
const DEPOSIT_ORIGINS = { base: BASE, arbitrum: ARBITRUM, ethereum: ETHEREUM } as const
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

export interface DepositQuoteInput {
  readonly from: keyof typeof DEPOSIT_ORIGINS
  readonly asset: 'ETH' | 'USDC'
  /** Decimal amount of `asset` the sender will send. */
  readonly amount: string
  readonly receive: 'ETH' | 'USDC'
  /** The owner's own address: it receives on Base and any refund. */
  readonly recipient: string
  readonly fetchFn?: typeof fetch | undefined
}

export interface DepositQuote {
  readonly requestId: string
  readonly depositAddress: string
  /** Decimal amount received on Base. */
  readonly expectedOut: string
  readonly feesUsd: string
  readonly timeEstimateSeconds: number
}

const decimalsOf = (asset: 'ETH' | 'USDC'): number => (asset === 'ETH' ? 18 : 6)

/**
 * A one-off Relay deposit address (`useDepositAddress`, keyless for EVM origins): whatever arrives there in `asset` on
 * `from` is delivered to `recipient` on Base as `receive`. Nothing is signed; the sender just transfers to the address.
 */
export const quoteDepositAddress = async (input: DepositQuoteInput): Promise<DepositQuote> => {
  if (input.from === 'base' && input.asset === input.receive)
    throw new BridgeError(
      'unsupported',
      `Send ${input.asset} on Base straight to your address; no deposit address is needed.`,
    )
  const origin = DEPOSIT_ORIGINS[input.from]
  const amount = parseUnits(input.amount, decimalsOf(input.asset))
  if (amount <= 0n) throw new BridgeError('unsupported', 'A deposit must be a positive amount.')
  const response = await (input.fetchFn ?? fetch)(`${API}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user: input.recipient,
      recipient: input.recipient,
      refundTo: input.recipient,
      originChainId: origin.id,
      destinationChainId: BASE.id,
      originCurrency: input.asset === 'ETH' ? NATIVE : origin.usdc.address,
      destinationCurrency: input.receive === 'ETH' ? NATIVE : BASE.usdc.address,
      amount: amount.toString(),
      tradeType: 'EXACT_INPUT',
      useDepositAddress: true,
    }),
  })
  // expected: a body that is not JSON reads as no quote; the checks below turn it into bad_quote.
  const raw: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new BridgeError('bad_quote', text(field(raw, 'message'), 'the deposit quote').slice(0, 200))
  const steps = field(raw, 'steps')
  const step: unknown = Array.isArray(steps) ? steps[0] : undefined
  const depositAddress = field(step, 'depositAddress')
  const requestId = field(step, 'requestId')
  const out = field(field(field(raw, 'details'), 'currencyOut'), 'amount')
  if (typeof depositAddress !== 'string' || !ADDRESS.test(depositAddress) || typeof requestId !== 'string')
    throw new BridgeError('bad_quote', 'Relay returned no deposit address.')
  if (typeof out !== 'string' || !/^\d+$/u.test(out))
    throw new BridgeError('bad_quote', 'Relay returned no output amount.')
  const seconds = field(field(raw, 'details'), 'timeEstimate')
  return {
    requestId,
    depositAddress,
    expectedOut: formatUnits(BigInt(out), decimalsOf(input.receive)),
    feesUsd: feesUsd(raw),
    timeEstimateSeconds: typeof seconds === 'number' && Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0,
  }
}

export type DepositState = 'waiting' | 'pending' | 'success' | 'refunded' | 'failed' | 'unknown'

/** Relay's intent statuses as the owner sees them; anything else (submitted, delayed, …) is still pending. */
const DEPOSIT_STATES: Readonly<Record<string, DepositState>> = {
  success: 'success',
  refunded: 'refunded',
  refund: 'refunded',
  failure: 'failed',
  waiting: 'waiting',
  unknown: 'waiting',
}

/**
 * Relay's progress for one deposit address, in the owner API's words. Relay records a fill as its own request whose
 * user is the deposit address; before anything arrives there is none, which is `waiting`. The keyless `requests/v2`
 * rate-limits (its keyed successor needs an API key), so a refusal is `unknown`, never a failure.
 */
export const depositStatus = async (
  depositAddress: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: DepositState; txHashes: string[] }> => {
  const response = await fetchFn(`${API}/requests/v2?user=${encodeURIComponent(depositAddress)}&limit=1`)
  if (!response.ok) return { status: 'unknown', txHashes: [] }
  const body: unknown = await response.json()
  const requests = field(body, 'requests')
  const latest: unknown = Array.isArray(requests) ? requests[0] : undefined
  if (latest === undefined) return { status: 'waiting', txHashes: [] }
  const status = field(latest, 'status')
  const data = field(latest, 'data')
  const hashes = ['inTxs', 'outTxs'].flatMap((key) => {
    const txs = field(data, key)
    return Array.isArray(txs) ? txs.map((tx: unknown) => field(tx, 'hash')) : []
  })
  return {
    status: (typeof status === 'string' ? DEPOSIT_STATES[status] : undefined) ?? 'pending',
    txHashes: hashes.filter((hash): hash is string => typeof hash === 'string' && /^0x[0-9a-fA-F]{1,128}$/u.test(hash)),
  }
}
