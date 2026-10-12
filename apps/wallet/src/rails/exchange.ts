import { formatUnits, parseUnits } from '@goblin/wallet/amounts'
import { decodeFrozenSwap, executeSwap, quoteSwap, type FrozenSwap } from '@goblin/wallet/lifi'
import { decodeFrozenBridge, executeBridge, quoteBridge, type FrozenBridge } from '@goblin/wallet/bridge'
import { ARBITRUM, BASE, ETHEREUM, TEMPO } from '@goblin/wallet/chains'
import type { BridgeQuoteInput, Operation, Payment, SwapQuoteInput } from '@goblin/wallet/contract'
import type { FrozenQuote, PayOutcome } from '../services/rails.ts'
import { RailError, type RailsDeps } from './deps.ts'
import { outcomeOfError } from './transfer.ts'

const CHAINS = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM, tempo: TEMPO } as const

const agentOf = async (deps: RailsDeps): Promise<string> => {
  const address = deps.signer?.address ?? (await deps.profile()).agentAddress
  if (address === undefined) throw new RailError('The owner has not created the agent wallet yet.')
  return address
}

/** LI.FI and Relay quote mainnets only; on testnets a swap or bridge would sign mainnet calldata, so it is refused. */
const requireLive = (deps: RailsDeps): void => {
  if (!deps.live) throw new RailError('Swaps and bridges run on mainnet only; this wallet is on testnets.')
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

/** The stored quote must be the one the operation's terms describe: token, amount and recipient. */
const assertSwapTerms = (operation: Operation, swap: FrozenSwap, agent: string): void => {
  const { terms } = operation
  if (
    terms.kind !== 'swap' ||
    !same(terms.token.address, swap.sell.address) ||
    parseUnits(terms.amount, swap.sell.decimals).toString() !== swap.sellAmount ||
    !same(terms.recipient, swap.agent) ||
    !same(swap.agent, agent)
  )
    throw new RailError('The quote does not match the approved swap; ask for a new one.')
}

/** Reads a stored quote before anything is signed: an unreadable or mismatched one fails, it is never uncertain. */
const storedQuote = <A>(read: () => A): A | PayOutcome => {
  try {
    return read()
  } catch (error) {
    // expected: nothing has been signed yet, so any refusal here is a plain failure.
    const reason = error instanceof RailError ? error.message : 'The stored quote is unreadable; ask for a new one.'
    return { outcome: 'failed', reason }
  }
}

const isOutcome = (value: object): value is PayOutcome => 'outcome' in value

const assertBridgeTerms = (operation: Operation, bridge: FrozenBridge, agent: string): void => {
  const { terms } = operation
  if (
    terms.kind !== 'bridge' ||
    terms.chain !== bridge.from ||
    !same(terms.token.address, CHAINS[bridge.from].usdc.address) ||
    parseUnits(terms.amount, terms.token.decimals).toString() !== bridge.amountIn ||
    !same(terms.recipient, bridge.recipient) ||
    !same(bridge.agent, agent)
  )
    throw new RailError('The quote does not match the approved bridge; ask for a new one.')
}

const quoteId = (kind: string): string => `${kind}_${crypto.randomUUID().replaceAll('-', '')}`

export const swapQuote = async (input: SwapQuoteInput, deps: RailsDeps): Promise<FrozenQuote> => {
  requireLive(deps)
  if (input.chain !== 'base') throw new RailError('Swaps run on Base only for now.')
  const agent = await agentOf(deps)
  const swap = await quoteSwap({
    sell: input.sell,
    buy: input.buy,
    amount: input.amount,
    agent,
    ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  const min = formatUnits(BigInt(swap.buyAmountMin), swap.buy.decimals)
  return {
    quote: {
      quote_id: quoteId('swap'),
      summary: `Swap ${input.amount} ${swap.sell.symbol} for at least ${min} ${swap.buy.symbol} on Base via ${swap.tool}`,
      amountUsd: swap.sellUsd,
      feesUsd: swap.feesUsd,
      minimumReceived: min,
      expiresAt: swap.expiresAt,
    },
    terms: {
      kind: 'swap',
      chain: 'base',
      rail: 'lifi',
      subject: `Swap ${swap.sell.symbol} to ${swap.buy.symbol}`,
      token: { symbol: swap.sell.symbol, address: swap.sell.address, decimals: swap.sell.decimals },
      amount: input.amount,
      amountUsd: swap.sellUsd,
      recipient: agent,
      expiresAt: swap.expiresAt,
    },
    payload: swap,
  }
}

const paymentOf = (rail: Payment['rail'], explorerUrl: string, txHash: string, now: Date): Payment => ({
  rail,
  txHash,
  explorerUrl,
  settledAt: now.toISOString(),
})

export const swapExecute = async (operation: Operation, payload: unknown, deps: RailsDeps): Promise<PayOutcome> => {
  if (deps.signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  const { signer } = deps
  const swap = storedQuote(() => {
    requireLive(deps)
    const decoded = decodeFrozenSwap(payload)
    assertSwapTerms(operation, decoded, signer.address)
    return decoded
  })
  if (isOutcome(swap)) return swap
  try {
    const result = await executeSwap({
      swap,
      agent: deps.signer,
      rpc: deps.rpcFor('base'),
      operationKey: operation.id,
      ...(deps.wait === undefined ? {} : { wait: deps.wait }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
    if (result.status === 'pending')
      return { outcome: 'uncertain', reason: 'The swap was sent but has not confirmed yet.' }
    if (result.status === 'reverted') return { outcome: 'failed', reason: 'The chain rejected the swap.' }
    const now = (deps.now ?? (() => new Date()))()
    return { outcome: 'settled', payment: paymentOf('lifi', result.explorerUrl, result.txHash, now) }
  } catch (error) {
    // expected: every failure is mapped to an outcome the spend program acts on (failed or uncertain).
    return outcomeOfError(error)
  }
}

export const bridgeQuote = async (input: BridgeQuoteInput, deps: RailsDeps): Promise<FrozenQuote> => {
  requireLive(deps)
  const agent = await agentOf(deps)
  const bridge = await quoteBridge({
    from: input.from,
    to: input.to,
    token: input.token,
    amount: input.amount,
    agent,
    ...(input.recipient === undefined ? {} : { recipient: input.recipient }),
    ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  })
  const origin = CHAINS[bridge.from]
  const destination = CHAINS[bridge.to]
  const min = formatUnits(BigInt(bridge.amountOutMin), destination.usdc.decimals)
  return {
    quote: {
      quote_id: quoteId('bridge'),
      summary: `Bridge ${input.amount} ${origin.usdc.symbol} from ${origin.name} to ${destination.name}: at least ${min} ${destination.usdc.symbol} in about ${bridge.timeEstimateSeconds}s via Relay`,
      amountUsd: bridge.amountInUsd,
      feesUsd: bridge.feesUsd,
      minimumReceived: min,
      expiresAt: bridge.expiresAt,
    },
    terms: {
      kind: 'bridge',
      chain: bridge.from,
      rail: 'relay',
      subject: `Bridge ${origin.name} to ${destination.name}`,
      token: { symbol: origin.usdc.symbol, address: origin.usdc.address, decimals: origin.usdc.decimals },
      amount: input.amount,
      amountUsd: bridge.amountInUsd,
      recipient: bridge.recipient,
      expiresAt: bridge.expiresAt,
    },
    payload: bridge,
  }
}

export const bridgeExecute = async (operation: Operation, payload: unknown, deps: RailsDeps): Promise<PayOutcome> => {
  if (deps.signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  const { signer } = deps
  const bridge = storedQuote(() => {
    requireLive(deps)
    const decoded = decodeFrozenBridge(payload)
    assertBridgeTerms(operation, decoded, signer.address)
    return decoded
  })
  if (isOutcome(bridge)) return bridge
  try {
    const result = await executeBridge({
      bridge,
      agent: deps.signer,
      rpc: deps.rpcFor(bridge.from),
      operationKey: operation.id,
      ...(deps.wait === undefined ? {} : { wait: deps.wait }),
      ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
    if (result.status === 'pending')
      return { outcome: 'uncertain', reason: 'The bridge deposit was sent but has not confirmed yet.' }
    if (result.status === 'reverted') return { outcome: 'failed', reason: 'The chain rejected the bridge deposit.' }
    const now = (deps.now ?? (() => new Date()))()
    return {
      outcome: 'settled',
      payment: paymentOf('relay', result.explorerUrl, result.txHash, now),
      delivery: { status: result.delivery, detail: `Relay: ${result.detail}` },
    }
  } catch (error) {
    // expected: every failure is mapped to an outcome the spend program acts on (failed or uncertain).
    return outcomeOfError(error)
  }
}
