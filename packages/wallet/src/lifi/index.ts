/**
 * Token swaps on Base through LI.FI (`li.quest/v1/quote`, keyless). A quote is frozen: the transaction request LI.FI
 * returned is what executes, byte for byte, until it expires. Before anything is signed the transaction is checked
 * (the LI.FI Diamond, the agent as sender, price impact within bounds), its calldata is decoded and must pay the agent
 * exactly the quoted swap (`verify.ts`), it is simulated from the agent, and approvals are for the exact sell amount.
 * A quote without a USD valuation is refused, never valued at zero.
 */
import * as Data from 'effect/Data'
import * as Schema from 'effect/Schema'
import { encodeFunctionData, parseAbi } from 'viem'
import { formatUnits, parseUnits } from '../amounts/index.ts'
import { toAddress, toHex } from '../balances/hex.ts'
import { erc20Balance } from '../balances/erc20.ts'
import { field, quantity } from '../balances/rpc.ts'
import { sendCalls } from '../balances/agent-send.ts'
import type { EvmChain } from '../balances/send.ts'
import type { AgentRoute } from '../balances/transfer.ts'
import type { Call } from '../userop/index.ts'
import { BASE } from '../chains/index.ts'
import { swapCalldataMismatch } from './verify.ts'

/** The LI.FI Diamond: the only contract a swap transaction may call (same address on Base and the other EVM chains). */
export const LIFI_DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const NATIVE = '0x0000000000000000000000000000000000000000'
const BASE_KEY: EvmChain = 'base'
const API = 'https://li.quest/v1/quote'

export interface SwapToken {
  readonly symbol: string
  readonly address: string
  readonly decimals: number
}

/** The tokens the agent may swap between on Base. A symbol outside this list is refused, never guessed. */
export const BASE_TOKENS: readonly SwapToken[] = [
  { symbol: 'ETH', address: NATIVE, decimals: 18 },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
  { symbol: 'USDC', address: BASE.usdc.address, decimals: 6 },
]

export type SwapFailure = 'unsupported' | 'bad_quote' | 'price_impact' | 'expired' | 'insufficient_funds'

export class SwapError extends Data.TaggedError('SwapError')<{
  readonly code: SwapFailure
  readonly message: string
}> {
  constructor(code: SwapFailure, message: string) {
    super({ code, message })
  }
}

const SwapTokenSchema = Schema.Struct({ symbol: Schema.String, address: Schema.String, decimals: Schema.Int })

/** A frozen quote. Strings only, so it is JSON-safe for the ledger; `decodeFrozenSwap` reads it back. */
export const FrozenSwapSchema = Schema.Struct({
  chain: Schema.Literal('base'),
  sell: SwapTokenSchema,
  buy: SwapTokenSchema,
  /** Base units of the sell token. */
  sellAmount: Schema.String,
  buyAmount: Schema.String,
  buyAmountMin: Schema.String,
  transaction: Schema.Struct({ to: Schema.String, data: Schema.String, value: Schema.String, chainId: Schema.Int }),
  approvalAddress: Schema.String,
  sellUsd: Schema.String,
  buyUsd: Schema.String,
  feesUsd: Schema.String,
  tool: Schema.String,
  agent: Schema.String,
  quotedAt: Schema.String,
  expiresAt: Schema.String,
})
export type FrozenSwap = typeof FrozenSwapSchema.Type

export const decodeFrozenSwap = Schema.decodeUnknownSync(FrozenSwapSchema)

export interface SwapQuoteInput {
  readonly sell: string
  readonly buy: string
  /** Decimal amount of the sell token. */
  readonly amount: string
  readonly agent: string
  /** Slippage as a fraction; capped at 1%. */
  readonly slippage?: number
  readonly fetchFn?: typeof fetch
  readonly now?: () => Date
  /** How long the frozen quote stays executable. Default 90 seconds. */
  readonly ttlSeconds?: number
}

const tokenOf = (symbol: string): SwapToken => {
  const token = BASE_TOKENS.find((candidate) => candidate.symbol === symbol.toUpperCase())
  if (token === undefined) throw new SwapError('unsupported', `${symbol} is not a token the wallet swaps on Base.`)
  return token
}

/** USD strings from the API ("0.9964" or a longer decimal) cut to the contract's six decimals; missing is refused. */
const usd = (value: unknown, what: string): string => {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  const [whole = '', fraction = ''] = text.split('.')
  if (!/^\d+$/u.test(whole) || !/^\d*$/u.test(fraction))
    throw new SwapError('bad_quote', `The quote has no USD value for ${what}.`)
  return `${whole}${fraction === '' ? '' : `.${fraction.slice(0, 6)}`}`
}

const sumUsd = (costs: unknown): bigint => {
  if (!Array.isArray(costs)) return 0n
  return costs.reduce<bigint>(
    (total, cost: unknown) => total + parseUnits(usd(field(cost, 'amountUSD'), 'a fee'), 6),
    0n,
  )
}

const INTEGER = /^(?:0x[0-9a-fA-F]+|\d+)$/u
const big = (value: string, what: string): bigint => {
  if (!INTEGER.test(value)) throw new SwapError('bad_quote', `The quote's ${what} is not an integer.`)
  return BigInt(value)
}

const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase()

/** LI.FI's `action` must restate the request: tokens, amount, chain and the agent on both ends. */
const checkAction = (raw: unknown, input: SwapQuoteInput, sell: SwapToken, buy: SwapToken, sellAmount: bigint) => {
  const action = field(raw, 'action')
  const matches =
    same(field(field(action, 'fromToken'), 'address'), sell.address) &&
    same(field(field(action, 'toToken'), 'address'), buy.address) &&
    field(action, 'fromAmount') === sellAmount.toString() &&
    field(action, 'fromChainId') === BASE.id &&
    field(action, 'toChainId') === BASE.id &&
    same(field(action, 'fromAddress'), input.agent) &&
    same(field(action, 'toAddress'), input.agent)
  if (!matches) throw new SwapError('bad_quote', 'The quote does not restate the requested swap.')
}

/** Refuses a frozen swap whose transaction does not do exactly what the quote says. */
const verifySwap = (swap: FrozenSwap): void => {
  if (
    swap.transaction.to.toLowerCase() !== LIFI_DIAMOND.toLowerCase() ||
    swap.approvalAddress.toLowerCase() !== LIFI_DIAMOND.toLowerCase() ||
    swap.transaction.chainId !== BASE.id
  )
    throw new SwapError('bad_quote', 'The quote calls an unknown contract.')
  const mismatch = swapCalldataMismatch(toHex(swap.transaction.data), {
    agent: swap.agent,
    sellToken: swap.sell.address,
    buyToken: swap.buy.address,
    sellAmount: big(swap.sellAmount, 'sell amount'),
    buyAmountMin: big(swap.buyAmountMin, 'minimum received'),
    value: big(swap.transaction.value, 'value'),
  })
  if (mismatch !== undefined) throw new SwapError('bad_quote', mismatch)
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string') throw new SwapError('bad_quote', `The quote has no ${what}.`)
  return value
}

/** Checks the quote LI.FI returned against everything the wallet insists on, and freezes it. */
const freeze = (raw: unknown, input: SwapQuoteInput, sell: SwapToken, buy: SwapToken, now: Date): FrozenSwap => {
  const request = field(raw, 'transactionRequest')
  const estimate = field(raw, 'estimate')
  const to = text(field(request, 'to'), 'transaction target')
  if (to.toLowerCase() !== LIFI_DIAMOND.toLowerCase())
    throw new SwapError('bad_quote', 'The quote calls an unknown contract.')
  if (
    text(field(request, 'from'), 'sender').toLowerCase() !== input.agent.toLowerCase() ||
    field(request, 'chainId') !== BASE.id
  )
    throw new SwapError('bad_quote', 'The quote is not for the agent wallet on Base.')
  const approvalAddress = text(field(estimate, 'approvalAddress'), 'approval address')
  if (approvalAddress.toLowerCase() !== LIFI_DIAMOND.toLowerCase())
    throw new SwapError('bad_quote', 'The quote asks to approve an unknown contract.')
  const sellAmount = parseUnits(input.amount, sell.decimals)
  if (field(estimate, 'fromAmount') !== sellAmount.toString())
    throw new SwapError('bad_quote', 'The quote sells a different amount than requested.')
  checkAction(raw, input, sell, buy, sellAmount)
  const sellUsd = usd(field(estimate, 'fromAmountUSD'), 'the sell amount')
  const buyUsd = usd(field(estimate, 'toAmountUSD'), 'the buy amount')
  if (parseUnits(buyUsd, 6) * 100n < parseUnits(sellUsd, 6) * 96n)
    throw new SwapError('price_impact', 'The swap would lose more than 4% to price impact.')
  const ttl = input.ttlSeconds ?? 90
  const frozen: FrozenSwap = {
    chain: 'base',
    sell,
    buy,
    sellAmount: sellAmount.toString(),
    buyAmount: text(field(estimate, 'toAmount'), 'buy amount'),
    buyAmountMin: text(field(estimate, 'toAmountMin'), 'minimum received'),
    transaction: {
      to,
      data: text(field(request, 'data'), 'calldata'),
      value: text(field(request, 'value'), 'value'),
      chainId: BASE.id,
    },
    approvalAddress,
    sellUsd,
    buyUsd,
    feesUsd: formatUnits(sumUsd(field(estimate, 'feeCosts')) + sumUsd(field(estimate, 'gasCosts')), 6),
    tool: typeof field(raw, 'tool') === 'string' ? text(field(raw, 'tool'), 'tool') : 'lifi',
    agent: input.agent,
    quotedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
  }
  verifySwap(frozen)
  return frozen
}

/** Asks LI.FI for a Base swap quote for the agent wallet and freezes it. */
export const quoteSwap = async (input: SwapQuoteInput): Promise<FrozenSwap> => {
  const sell = tokenOf(input.sell)
  const buy = tokenOf(input.buy)
  if (sell.symbol === buy.symbol) throw new SwapError('unsupported', 'Sell and buy are the same token.')
  const slippage = Math.min(input.slippage ?? 0.005, 0.01)
  const params = new URLSearchParams({
    fromChain: String(BASE.id),
    toChain: String(BASE.id),
    fromToken: sell.address,
    toToken: buy.address,
    fromAmount: parseUnits(input.amount, sell.decimals).toString(),
    fromAddress: input.agent,
    toAddress: input.agent,
    slippage: String(slippage),
  })
  const response = await (input.fetchFn ?? fetch)(`${API}?${params.toString()}`, {
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new SwapError('bad_quote', `LI.FI answered ${response.status}.`)
  return freeze(await response.json(), input, sell, buy, (input.now ?? (() => new Date()))())
}

const ERC20 = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

export interface ExecuteSwapInput extends Omit<AgentRoute, 'chain'> {
  readonly swap: FrozenSwap
  readonly operationKey: string
  readonly now?: () => Date
}

export interface SwapResult {
  readonly userOpHash: string
  /** The bundle's transaction, once mined. */
  readonly txHash?: string | undefined
  readonly status: 'success' | 'reverted' | 'pending'
  readonly explorerUrl?: string | undefined
}

/** The swap's calls: the exact approval when it sells a token, then the quoted transaction, unchanged. */
const swapCalls = (swap: FrozenSwap): Call[] => {
  const trade: Call = {
    target: swap.transaction.to,
    value: BigInt(swap.transaction.value),
    callData: toHex(swap.transaction.data),
  }
  if (swap.sell.address === NATIVE) return [trade]
  const approve = encodeFunctionData({
    abi: ERC20,
    functionName: 'approve',
    args: [toAddress(swap.approvalAddress), BigInt(swap.sellAmount)],
  })
  return [{ target: swap.sell.address, value: 0n, callData: approve }, trade]
}

/**
 * Executes a frozen swap as one UserOperation: a USDC sale's shortfall is redeemed from the owner's allowance in the
 * same batch, then the exact approval and the quoted transaction; they land together or not at all.
 */
export const executeSwap = async (input: ExecuteSwapInput): Promise<SwapResult> => {
  const { swap } = input
  if ((input.now ?? (() => new Date()))().getTime() > Date.parse(swap.expiresAt))
    throw new SwapError('expired', 'The quote expired; ask for a new one.')
  if (swap.agent.toLowerCase() !== input.agent.address.toLowerCase())
    throw new SwapError('bad_quote', 'The frozen quote does not match this wallet; ask for a new one.')
  verifySwap(swap)
  const sellAmount = BigInt(swap.sellAmount)
  const sellsUsdc = swap.sell.address.toLowerCase() === BASE.usdc.address.toLowerCase()
  if (!sellsUsdc) {
    const held =
      swap.sell.address === NATIVE
        ? quantity(await input.rpc('eth_getBalance', [swap.agent, 'latest']))
        : await erc20Balance(input.rpc, swap.sell.address, swap.agent)
    if (held < sellAmount)
      throw new SwapError('insufficient_funds', `The agent wallet holds less ${swap.sell.symbol} than the swap sells.`)
  }
  const sent = await sendCalls(
    { ...input, chain: BASE_KEY },
    { key: `${input.operationKey}:swap`, calls: swapCalls(swap), spends: sellsUsdc ? sellAmount : 0n },
  )
  return {
    userOpHash: sent.userOpHash,
    txHash: sent.txHash,
    status: sent.status,
    ...(sent.txHash === undefined ? {} : { explorerUrl: `${BASE.explorerUrl}/tx/${sent.txHash}` }),
  }
}
