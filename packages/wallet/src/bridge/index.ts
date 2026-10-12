/**
 * Bridges with Relay (`api.relay.link/quote/v2`, keyless): Base, Ethereum or Arbitrum USDC to USDC on Base, Ethereum,
 * Arbitrum or Tempo (USDC.e). A quote is frozen; execution runs exactly the quoted steps. Every step is checked before
 * it is signed: from the agent, on the origin chain, zero native value, only an exact-amount USDC approval to Relay's
 * depository and the deposit into that same depository. Then Relay is polled until the funds land or are refunded.
 */
import { decodeFunctionData, parseAbi } from 'viem'
import { formatUnits, parseUnits } from '../amounts/index.ts'
import { toHex } from '../balances/hex.ts'
import { field, type JsonRpc, type WaitOptions } from '../balances/rpc.ts'
import { sendSimulated, TransferError, type EvmChain } from '../balances/send.ts'
import { ARBITRUM, BASE, ETHEREUM, TEMPO, type Chain } from '../chains/index.ts'
import type { AgentSigner, ChainKey } from '../contract/index.ts'

/** Relay's depository: the same address on every chain Relay serves. */
export const RELAY_DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
const API = 'https://api.relay.link'

const CHAINS: Readonly<Record<ChainKey, Chain>> = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM, tempo: TEMPO }

export type BridgeFailure = 'unsupported' | 'bad_quote' | 'expired' | 'insufficient_funds'

export class BridgeError extends Error {
  readonly code: BridgeFailure
  constructor(code: BridgeFailure, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

export interface BridgeStep {
  readonly id: 'approve' | 'deposit'
  readonly to: string
  readonly data: string
}

/** A frozen bridge quote. Strings only, so it is JSON-safe for the ledger. */
export interface FrozenBridge {
  readonly from: EvmChain
  readonly to: ChainKey
  readonly requestId: string
  readonly steps: readonly BridgeStep[]
  /** USDC base units sent on the origin chain. */
  readonly amountIn: string
  readonly amountOut: string
  readonly amountOutMin: string
  readonly amountInUsd: string
  readonly feesUsd: string
  readonly timeEstimateSeconds: number
  /** The destination-chain recipient. */
  readonly recipient: string
  readonly agent: string
  readonly quotedAt: string
  readonly expiresAt: string
}

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

const usd = (value: unknown): string => {
  const text = typeof value === 'string' ? value : '0'
  const [whole = '0', fraction = ''] = text.split('.')
  return /^\d+$/u.test(whole) ? `${whole}${fraction === '' ? '' : `.${fraction.slice(0, 6)}`}` : '0'
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new BridgeError('bad_quote', `The quote has no ${what}.`)
  return value
}

const APPROVE = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

const checkStep = (item: unknown, id: string, input: BridgeQuoteInput, amountIn: bigint): BridgeStep => {
  const data = field(item, 'data')
  const to = text(field(data, 'to'), 'step target')
  const calldata = text(field(data, 'data'), 'step calldata')
  const origin = CHAINS[input.from]
  if (
    text(field(data, 'from'), 'step sender').toLowerCase() !== input.agent.toLowerCase() ||
    field(data, 'chainId') !== origin.id
  )
    throw new BridgeError('bad_quote', 'A step is not for the agent wallet on the origin chain.')
  const value = field(data, 'value')
  if (value !== undefined && !['0', '0x0', ''].includes(text(value, 'step value')))
    throw new BridgeError('bad_quote', 'A step sends native value.')
  if (id === 'approve') {
    if (to.toLowerCase() !== origin.usdc.address.toLowerCase())
      throw new BridgeError('bad_quote', 'The approval is not for USDC.')
    const [spender, amount] = decodeFunctionData({ abi: APPROVE, data: toHex(calldata) }).args
    if (spender.toLowerCase() !== RELAY_DEPOSITORY || amount > amountIn)
      throw new BridgeError('bad_quote', 'The approval is not the exact amount to Relay.')
    return { id: 'approve', to, data: calldata }
  }
  if (id === 'deposit' && to.toLowerCase() === RELAY_DEPOSITORY) return { id: 'deposit', to, data: calldata }
  throw new BridgeError('bad_quote', `The quote has a step the wallet does not run (${id}).`)
}

const stepsOf = (raw: unknown, input: BridgeQuoteInput, amountIn: bigint): BridgeStep[] => {
  const steps = field(raw, 'steps')
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 2)
    throw new BridgeError('bad_quote', 'The quote has no runnable steps.')
  return steps.map((step: unknown) => {
    const items = field(step, 'items')
    if (field(step, 'kind') !== 'transaction' || !Array.isArray(items) || items.length !== 1)
      throw new BridgeError('bad_quote', 'A quote step is not a single transaction.')
    return checkStep(items[0], text(field(step, 'id'), 'step id'), input, amountIn)
  })
}

const feesUsd = (raw: unknown): string => {
  const fees = field(raw, 'fees')
  const parts = ['gas', 'relayer', 'app'].map((name) => parseUnits(usd(field(field(fees, name), 'amountUsd')), 6))
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
  if (text(field(details, 'recipient'), 'recipient').toLowerCase() !== recipient.toLowerCase())
    throw new BridgeError('bad_quote', 'The quote pays someone else.')
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
    amountInUsd: usd(field(field(details, 'currencyIn'), 'amountUsd')),
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

/** Executes a frozen bridge: the approval (if quoted), the deposit, then Relay's delivery status. */
export const executeBridge = async (input: ExecuteBridgeInput): Promise<BridgeResult> => {
  const { bridge } = input
  if ((input.now ?? (() => new Date()))().getTime() > Date.parse(bridge.expiresAt))
    throw new BridgeError('expired', 'The quote expired; ask for a new one.')
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
    if (step.id === 'deposit') deposit = sent
  }
  if (deposit === undefined) throw new BridgeError('bad_quote', 'The quote has no deposit step.')
  const explorerUrl = `${CHAINS[bridge.from].explorerUrl}/tx/${deposit.hash}`
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
