/**
 * EVM stablecoin transfers from the agent wallet, with a just-in-time top-up from the owner. The agent holds little;
 * a transfer it cannot cover redeems the owner's ERC-7710 allowance (`DelegationManager.redeemDelegations`) for exactly
 * the shortfall plus the gas, in the same UserOperation as the payment (`agent-send.ts`). The allowance is enforced
 * on-chain by the ERC20PeriodTransfer enforcer, whatever this code does.
 */
import { encodeFunctionData, parseAbi } from 'viem'
import { chainByKey } from '../chains/index.ts'
import type { AgentSigner } from '../contract/index.ts'
import { sendCalls, type AgentSent, type TopUp } from './agent-send.ts'
import { erc20Balance } from './erc20.ts'
import { toAddress } from './hex.ts'
import type { JsonRpc, WaitOptions } from './rpc.ts'
import { TransferError, type EvmChain } from './send.ts'

export type { EvmChain } from './send.ts'
export { TransferError, type TransferFailure } from './send.ts'
export type { TopUp } from './agent-send.ts'

/** What every agent send needs besides its calls: the chain, the signer, the node, the bundler, the allowance. */
export interface AgentRoute {
  /** Mainnets when true (`WALLET_LIVE=1`), their testnets otherwise: the token, manager and explorer follow it. */
  readonly live: boolean
  readonly chain: EvmChain
  readonly agent: AgentSigner
  readonly rpc: JsonRpc
  readonly bundler?: JsonRpc | undefined
  readonly topUp?: TopUp | undefined
  readonly wait?: WaitOptions | undefined
  readonly onSubmitted?: ((userOpHash: string) => Promise<void> | void) | undefined
}

export interface EvmTransferInput extends AgentRoute {
  readonly to: string
  /** Base units of the chain's USDC. */
  readonly amount: bigint
  readonly operationKey: string
}

export interface EvmTransferResult {
  readonly userOpHash: string
  /** The bundle's transaction, once mined. */
  readonly txHash?: string | undefined
  readonly status: AgentSent['status']
  readonly explorerUrl?: string | undefined
  /** USDC pulled from the owner's allowance in the same operation (the shortfall plus the gas). */
  readonly topUpAmount?: bigint
}

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

/** Pays `amount` USDC to `to` from the agent, topping up from the owner's allowance in the same operation. */
export const transferUsdc = async (input: EvmTransferInput): Promise<EvmTransferResult> => {
  // A zero transfer moves nothing the ledger counts but still costs gas.
  if (input.amount <= 0n) throw new TransferError('invalid_amount', 'A transfer must move a positive amount.')
  if (input.to.toLowerCase() === input.agent.address.toLowerCase())
    throw new TransferError('invalid_amount', 'The agent wallet cannot pay itself.')
  const chain = chainByKey(input.chain, input.live)
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [toAddress(input.to), input.amount] })
  const sent = await sendCalls(input, {
    key: `${input.operationKey}:pay`,
    calls: [{ target: chain.usdc.address, value: 0n, callData: data }],
    spends: input.amount,
  })
  return {
    userOpHash: sent.userOpHash,
    txHash: sent.txHash,
    status: sent.status,
    ...(sent.txHash === undefined ? {} : { explorerUrl: `${chain.explorerUrl}/tx/${sent.txHash}` }),
    ...(sent.toppedUp === 0n ? {} : { topUpAmount: sent.toppedUp }),
  }
}

export interface EnsureFundsInput extends AgentRoute {
  /** Base units of the chain's USDC the agent is about to spend outside a UserOperation (an x402 authorization). */
  readonly amount: bigint
  readonly operationKey: string
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Waits until the RPC shows the topped-up balance: a load-balanced RPC can answer the next read from a node that has
 * not seen the top-up's block, and an x402 facilitator would then see too little. Nothing of the payment is signed
 * yet, so giving up is a plain failure; the agent keeps the topped-up USDC for the next attempt.
 */
const untilVisible = async (input: EnsureFundsInput, token: string): Promise<void> => {
  const sleep = input.wait?.sleep ?? pause
  for (let attempt = 0; attempt < (input.wait?.attempts ?? 10); attempt += 1) {
    // expected: an unanswered read counts as not visible yet; the loop asks again.
    const held = await erc20Balance(input.rpc, token, input.agent.address).catch(() => 0n)
    if (held >= input.amount) return
    await sleep(input.wait?.intervalMs ?? 1000)
  }
  throw new TransferError(
    'rpc_unavailable',
    'The allowance top-up landed but the chain did not show it in time; nothing was paid. Try again.',
  )
}

/**
 * Makes sure the agent holds `amount` USDC for a payment it signs off-chain (x402): when it is short, one UserOperation
 * redeems the shortfall plus its own gas from the owner's allowance.
 */
export const ensureUsdc = async (input: EnsureFundsInput): Promise<{ topUpTxHash?: string; topUpAmount?: bigint }> => {
  const chain = chainByKey(input.chain, input.live)
  const held = await erc20Balance(input.rpc, chain.usdc.address, input.agent.address).catch(() => {
    throw new TransferError('rpc_unavailable', 'The chain did not answer the balance before signing; nothing was sent.')
  })
  if (held >= input.amount) return {}
  const sent = await sendCalls(input, { key: `${input.operationKey}:topup`, calls: [], spends: input.amount })
  if (sent.status !== 'success')
    throw new TransferError(
      sent.status === 'pending' ? 'uncertain' : 'reverted',
      'The allowance top-up did not confirm.',
      sent.status === 'pending',
    )
  await untilVisible(input, chain.usdc.address)
  return { ...(sent.txHash === undefined ? {} : { topUpTxHash: sent.txHash }), topUpAmount: sent.toppedUp }
}
