/**
 * EVM stablecoin transfers from the agent wallet, with a just-in-time top-up from the owner. The agent holds little;
 * when a transfer needs more than it has, it redeems the owner's ERC-7710 allowance (`DelegationManager.redeemDelegations`,
 * called by the agent) to pull exactly the shortfall, then pays. The allowance is enforced on-chain by the
 * ERC20PeriodTransfer enforcer, whatever this code does.
 */
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { formatUnits } from '../amounts/index.ts'
import { ARBITRUM, BASE, ETHEREUM, type Chain } from '../chains/index.ts'
import type { AgentSigner } from '../contract/index.ts'
import { toAddress } from './hex.ts'
import { erc20Balance } from './erc20.ts'
import { sendSimulated, TransferError, type EvmChain } from './send.ts'
import { quantity, type JsonRpc, type TxStatus, type WaitOptions } from './rpc.ts'

export type { EvmChain } from './send.ts'
export { TransferError, type TransferFailure } from './send.ts'

const CHAINS: Readonly<Record<EvmChain, Chain>> = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM }

/** How the agent pulls from the owner's allowance. Lane S's delegation encoders back this. */
export interface TopUp {
  /** Calldata for `DelegationManager.redeemDelegations` that moves `amount` of the stablecoin from owner to agent. */
  redeemCalldata(amount: bigint): Promise<Hex> | Hex
  /** What the enforcer still allows this period (base units). */
  available(): Promise<bigint>
}

export interface EvmTransferInput {
  readonly chain: EvmChain
  readonly to: string
  /** Base units of the chain's USDC. */
  readonly amount: bigint
  readonly operationKey: string
  readonly agent: AgentSigner
  readonly rpc: JsonRpc
  readonly topUp?: TopUp
  readonly wait?: WaitOptions
}

export interface EvmTransferResult {
  readonly txHash: Hex
  readonly status: TxStatus
  readonly explorerUrl: string
  /** The redeem transaction, when a top-up ran first. */
  readonly topUpTxHash?: Hex
  readonly topUpAmount?: bigint
}

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

const needTopUp = async (input: EnsureFundsInput, token: string): Promise<bigint> => {
  const held = await erc20Balance(input.rpc, token, input.agent.address)
  if (held >= input.amount) return 0n
  const shortfall = input.amount - held
  if (input.topUp === undefined)
    throw new TransferError(
      'insufficient_funds',
      `The agent wallet holds ${formatUnits(held, 6)} USDC; it needs ${formatUnits(input.amount, 6)}.`,
    )
  if (shortfall > (await input.topUp.available()))
    throw new TransferError('allowance_exhausted', 'The allowance is used up for this period (enforced on-chain).')
  return shortfall
}

const requireGas = async (input: { agent: AgentSigner; rpc: JsonRpc }): Promise<void> => {
  const gas = quantity(await input.rpc('eth_getBalance', [input.agent.address, 'latest']))
  if (gas === 0n) throw new TransferError('no_gas', 'The agent wallet has no gas on this chain.')
}

export interface EnsureFundsInput {
  readonly chain: EvmChain
  /** Base units of the chain's USDC the agent is about to spend. */
  readonly amount: bigint
  readonly operationKey: string
  readonly agent: AgentSigner
  readonly rpc: JsonRpc
  readonly topUp?: TopUp | undefined
  readonly wait?: WaitOptions | undefined
}

/** Makes sure the agent holds `amount` USDC, redeeming exactly the shortfall from the owner's allowance if it is short. */
export const ensureUsdc = async (input: EnsureFundsInput): Promise<{ topUpTxHash?: Hex; topUpAmount?: bigint }> => {
  const chain = CHAINS[input.chain]
  const shortfall = await needTopUp(input, chain.usdc.address)
  if (shortfall === 0n || input.topUp === undefined) return {}
  await requireGas(input)
  const data = await input.topUp.redeemCalldata(shortfall)
  const redeemed = await sendSimulated(input, {
    key: `${input.operationKey}:topup`,
    to: chain.delegation.manager,
    data,
  })
  if (redeemed.status !== 'success')
    throw new TransferError(
      redeemed.status === 'pending' ? 'uncertain' : 'reverted',
      'The allowance top-up did not confirm.',
      redeemed.status === 'pending',
    )
  return { topUpTxHash: redeemed.hash, topUpAmount: shortfall }
}

/** Pays `amount` USDC to `to` from the agent, topping up from the owner's allowance first when it is short. */
export const transferUsdc = async (input: EvmTransferInput): Promise<EvmTransferResult> => {
  const chain = CHAINS[input.chain]
  await requireGas(input)
  const funded = await ensureUsdc(input)
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [toAddress(input.to), input.amount] })
  const paid = await sendSimulated(input, { key: `${input.operationKey}:pay`, to: chain.usdc.address, data })
  return {
    txHash: paid.hash,
    status: paid.status,
    explorerUrl: `${chain.explorerUrl}/tx/${paid.hash}`,
    ...(funded.topUpTxHash === undefined ? {} : { topUpTxHash: funded.topUpTxHash }),
    ...(funded.topUpAmount === undefined ? {} : { topUpAmount: funded.topUpAmount }),
  }
}
