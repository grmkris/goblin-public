/**
 * EVM stablecoin transfers from the agent wallet, with a just-in-time top-up from the owner. The agent holds little;
 * when a transfer needs more than it has, it redeems the owner's ERC-7710 allowance (`DelegationManager.redeemDelegations`,
 * called by the agent) to pull exactly the shortfall, then pays. The allowance is enforced on-chain by the
 * ERC20PeriodTransfer enforcer, whatever this code does.
 */
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { formatUnits } from '../amounts/index.ts'
import { ARBITRUM, BASE, ETHEREUM, type Chain } from '../chains/index.ts'
import type { AgentSigner, ChainKey } from '../contract/index.ts'
import { toAddress, toHex } from './hex.ts'
import { erc20Balance } from './erc20.ts'
import { quantity, waitForReceipt, type JsonRpc, type TxStatus, type WaitOptions } from './rpc.ts'

export type EvmChain = Extract<ChainKey, 'base' | 'ethereum' | 'arbitrum'>

const CHAINS: Readonly<Record<EvmChain, Chain>> = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM }

export type TransferFailure = 'insufficient_funds' | 'no_gas' | 'allowance_exhausted' | 'reverted' | 'uncertain'

export class TransferError extends Error {
  readonly code: TransferFailure
  /** True when money may have moved; the caller must not retry blind. */
  readonly uncertain: boolean
  constructor(code: TransferFailure, message: string, uncertain = false) {
    super(message)
    this.name = 'TransferError'
    this.code = code
    this.uncertain = uncertain
  }
}

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

/** A revert message from `eth_call`, mapped to a sentence the owner and the model can act on. */
export const explainRevert = (message: string): { code: TransferFailure; text: string } => {
  if (message.includes('transfer-amount-exceeded'))
    return { code: 'allowance_exhausted', text: 'The allowance is used up for this period (enforced on-chain).' }
  if (/insufficient|exceeds balance/iu.test(message))
    return { code: 'insufficient_funds', text: 'The wallet does not hold enough for this transfer.' }
  return { code: 'reverted', text: 'The chain rejected the transaction.' }
}

const simulate = async (rpc: JsonRpc, call: { from: string; to: string; data: Hex }): Promise<void> => {
  try {
    await rpc('eth_call', [call, 'latest'])
  } catch (error) {
    const reason = explainRevert(error instanceof Error ? error.message : '')
    throw new TransferError(reason.code, reason.text)
  }
}

const send = async (
  input: EvmTransferInput,
  step: 'topup' | 'pay',
  call: { to: string; data: Hex },
): Promise<{ hash: Hex; status: TxStatus }> => {
  await simulate(input.rpc, { from: input.agent.address, ...call })
  let hash: Hex
  try {
    hash = toHex(
      await input.agent.sendTransaction({
        chain: input.chain,
        to: call.to,
        data: call.data,
        operationKey: `${input.operationKey}:${step}`,
      }),
    )
  } catch {
    // expected: a signer error after simulation may follow a broadcast, so the transfer is reported as uncertain.
    throw new TransferError('uncertain', 'The signer did not confirm the transaction.', true)
  }
  const status = await waitForReceipt(input.rpc, hash, input.wait)
  return { hash, status }
}

const needTopUp = async (input: EvmTransferInput, token: string): Promise<bigint> => {
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

/** Pays `amount` USDC to `to` from the agent, topping up from the owner's allowance first when it is short. */
export const transferUsdc = async (input: EvmTransferInput): Promise<EvmTransferResult> => {
  const chain = CHAINS[input.chain]
  const gas = quantity(await input.rpc('eth_getBalance', [input.agent.address, 'latest']))
  if (gas === 0n) throw new TransferError('no_gas', 'The agent wallet has no gas on this chain.')
  const shortfall = await needTopUp(input, chain.usdc.address)
  let topUpTxHash: Hex | undefined
  if (shortfall > 0n && input.topUp !== undefined) {
    const data = await input.topUp.redeemCalldata(shortfall)
    const redeemed = await send(input, 'topup', { to: chain.delegation.manager, data })
    if (redeemed.status !== 'success')
      throw new TransferError(
        redeemed.status === 'pending' ? 'uncertain' : 'reverted',
        'The allowance top-up did not confirm.',
        redeemed.status === 'pending',
      )
    topUpTxHash = redeemed.hash
  }
  const data = encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [toAddress(input.to), input.amount] })
  const paid = await send(input, 'pay', { to: chain.usdc.address, data })
  return {
    txHash: paid.hash,
    status: paid.status,
    explorerUrl: `${chain.explorerUrl}/tx/${paid.hash}`,
    ...(topUpTxHash === undefined ? {} : { topUpTxHash, topUpAmount: shortfall }),
  }
}
