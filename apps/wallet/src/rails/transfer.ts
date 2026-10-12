import { parseUnits } from '@goblin/wallet/amounts'
import { transferUsdc, TransferError, type EvmChain } from '@goblin/wallet/balances'
import { chainByKey } from '@goblin/wallet/chains'
import type { ChainKey, Operation, Payment, Terms, TransferInput } from '@goblin/wallet/contract'
import { isTempoAgent, transferTempoUsdc } from '@goblin/wallet/tempo'
import type { PayOutcome } from '../services/rails.ts'
import { RailError, type RailsDeps } from './deps.ts'

const TEN_MINUTES = 600_000
const TESTNET_TEMPO = 'Tempo transfers run on mainnet only; this wallet is on testnets.'

/** The stablecoin of a chain by symbol: USDC on the EVM chains, USDC.e (or "USDC") on Tempo. */
const tokenOf = (chain: ChainKey, symbol: string, live: boolean) => {
  const network = chainByKey(chain, live)
  const token = network.usdc
  const wanted = symbol.toUpperCase()
  if (wanted !== token.symbol.toUpperCase() && !(chain === 'tempo' && wanted === 'USDC'))
    throw new RailError(`${symbol} is not a token this wallet transfers on ${network.name}; use ${token.symbol}.`)
  return token
}

/**
 * A stablecoin transfer is worth its face value in USD. A zero amount and a payment to the agent itself are refused:
 * they move nothing the ledger counts while the agent still pays the gas.
 */
export const quoteTransfer = async (input: TransferInput, deps: RailsDeps): Promise<Terms> => {
  if (input.chain === 'tempo' && !deps.live) throw new RailError(TESTNET_TEMPO)
  const token = tokenOf(input.chain, input.token, deps.live)
  if (parseUnits(input.amount, token.decimals) <= 0n) throw new RailError('A transfer must move a positive amount.')
  const agent = deps.signer?.address ?? (await deps.profile()).agentAddress
  if (agent !== undefined && agent.toLowerCase() === input.to.toLowerCase())
    throw new RailError('The agent wallet cannot pay itself.')
  return termsOf(input, token, deps)
}

const termsOf = (input: TransferInput, token: ReturnType<typeof tokenOf>, deps: RailsDeps): Terms => {
  return {
    kind: 'transfer',
    chain: input.chain,
    rail: 'transfer',
    subject: `Send ${input.amount} ${token.symbol} on ${chainByKey(input.chain, deps.live).name}`,
    token: { symbol: token.symbol, address: token.address, decimals: token.decimals },
    amount: input.amount,
    amountUsd: input.amount,
    recipient: input.to,
    expiresAt: new Date((deps.now ?? (() => new Date()))().getTime() + TEN_MINUTES).toISOString(),
  }
}

const explorerPayment = (rail: Payment['rail'], url: string, txHash: string, now: Date): Payment => ({
  rail,
  txHash,
  explorerUrl: url,
  settledAt: now.toISOString(),
})

/** What a transfer-like failure means for the reservation: no money moved, or maybe it did. */
export const outcomeOfError = (error: unknown): PayOutcome => {
  if (error instanceof TransferError)
    return error.uncertain
      ? { outcome: 'uncertain', reason: error.message }
      : { outcome: 'failed', reason: error.message }
  if (error instanceof RailError) return { outcome: 'failed', reason: error.message }
  return { outcome: 'uncertain', reason: 'The wallet could not confirm whether the transfer happened.' }
}

const evmTransfer = async (operation: Operation, deps: RailsDeps, chain: EvmChain): Promise<PayOutcome> => {
  const { signer, topUp } = { signer: deps.signer, topUp: await deps.topUp?.(chain) }
  if (signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  const { terms } = operation
  const result = await transferUsdc({
    live: deps.live,
    chain,
    to: terms.recipient,
    amount: parseUnits(terms.amount, terms.token.decimals),
    operationKey: operation.id,
    agent: signer,
    rpc: deps.rpcFor(chain),
    ...(topUp === undefined ? {} : { topUp }),
    ...(deps.wait === undefined ? {} : { wait: deps.wait }),
  })
  if (result.status === 'pending')
    return { outcome: 'uncertain', reason: 'The transfer was sent but has not confirmed yet.' }
  if (result.status === 'reverted') return { outcome: 'failed', reason: 'The chain rejected the transfer.' }
  const now = (deps.now ?? (() => new Date()))()
  return { outcome: 'settled', payment: explorerPayment('transfer', result.explorerUrl, result.txHash, now) }
}

const tempoTransfer = async (operation: Operation, deps: RailsDeps): Promise<PayOutcome> => {
  const { signer } = deps
  if (signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  if (!deps.live) return { outcome: 'failed', reason: TESTNET_TEMPO }
  if (!isTempoAgent(signer)) return { outcome: 'failed', reason: 'The agent wallet cannot sign on Tempo yet.' }
  const { terms } = operation
  const result = await transferTempoUsdc({
    agent: signer,
    to: terms.recipient,
    amount: parseUnits(terms.amount, terms.token.decimals),
    operationKey: operation.id,
  })
  if (result.status !== 'success') return { outcome: 'failed', reason: 'The chain rejected the transfer.' }
  const now = (deps.now ?? (() => new Date()))()
  return { outcome: 'settled', payment: explorerPayment('transfer', result.explorerUrl, result.txHash, now) }
}

/** Pays a reserved transfer. A top-up from the owner's allowance happens inside, before the payment. */
export const transfer = async (operation: Operation, deps: RailsDeps): Promise<PayOutcome> => {
  try {
    const chain = operation.terms.chain
    return chain === 'tempo' ? await tempoTransfer(operation, deps) : await evmTransfer(operation, deps, chain)
  } catch (error) {
    // expected: every failure is mapped to an outcome the spend program acts on (failed or uncertain).
    return outcomeOfError(error)
  }
}
