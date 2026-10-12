/**
 * EVM stablecoin transfers from the agent wallet, with a just-in-time top-up from the owner. The agent holds little;
 * when a transfer needs more than it has, it redeems the owner's ERC-7710 allowance (`DelegationManager.redeemDelegations`,
 * called by the agent) to pull exactly the shortfall, then pays. The allowance is enforced on-chain by the
 * ERC20PeriodTransfer enforcer, whatever this code does.
 */
import { encodeFunctionData, parseAbi, type Hex } from 'viem'
import { formatUnits } from '../amounts/index.ts'
import { chainByKey } from '../chains/index.ts'
import type { AgentSigner } from '../contract/index.ts'
import { toAddress } from './hex.ts'
import { erc20Balance } from './erc20.ts'
import { sendSimulated, TransferError, type EvmChain } from './send.ts'
import { JsonRpcError, quantity, type JsonRpc, type TxStatus, type WaitOptions } from './rpc.ts'

export type { EvmChain } from './send.ts'
export { TransferError, type TransferFailure } from './send.ts'

/** How the agent pulls from the owner's allowance. Lane S's delegation encoders back this. */
export interface TopUp {
  /** Calldata for `DelegationManager.redeemDelegations` that moves `amount` of the stablecoin from owner to agent. */
  redeemCalldata(amount: bigint): Promise<Hex> | Hex
  /** What the enforcer still allows this period (base units). */
  available(): Promise<bigint>
}

export interface EvmTransferInput {
  /** Mainnets when true (`WALLET_LIVE=1`), their testnets otherwise: the token, manager and explorer follow it. */
  readonly live: boolean
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

/** Reads before anything is signed: a node that does not answer means nothing was sent, so the transfer failed. */
const beforeSigning = async <A>(read: () => Promise<A>): Promise<A> => {
  try {
    return await read()
  } catch (error) {
    if (error instanceof JsonRpcError)
      throw new TransferError('rpc_unavailable', 'The chain did not answer before signing; nothing was sent.')
    throw error
  }
}

const needTopUp = async (input: EnsureFundsInput, token: string): Promise<bigint> => {
  const held = await beforeSigning(() => erc20Balance(input.rpc, token, input.agent.address))
  if (held >= input.amount) return 0n
  const shortfall = input.amount - held
  const { topUp } = input
  if (topUp === undefined)
    throw new TransferError(
      'insufficient_funds',
      `The agent wallet holds ${formatUnits(held, 6)} USDC; it needs ${formatUnits(input.amount, 6)}.`,
    )
  if (shortfall > (await beforeSigning(() => topUp.available())))
    throw new TransferError('allowance_exhausted', 'The allowance is used up for this period (enforced on-chain).')
  return shortfall
}

const requireGas = async (input: { agent: AgentSigner; rpc: JsonRpc }): Promise<void> => {
  const gas = quantity(await input.rpc('eth_getBalance', [input.agent.address, 'latest']))
  if (gas === 0n) throw new TransferError('no_gas', 'The agent wallet has no gas on this chain.')
}

export interface EnsureFundsInput {
  /** The network (`WALLET_LIVE`); absent means mainnet, for callers that predate the switch. */
  readonly live?: boolean | undefined
  readonly chain: EvmChain
  /** Base units of the chain's USDC the agent is about to spend. */
  readonly amount: bigint
  readonly operationKey: string
  readonly agent: AgentSigner
  readonly rpc: JsonRpc
  readonly topUp?: TopUp | undefined
  readonly wait?: WaitOptions | undefined
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Waits until the RPC shows the topped-up balance. A load-balanced public RPC can answer the next read from a node that
 * has not seen the top-up's block, and the payment's simulation would then fail for want of funds. Nothing of the
 * payment is signed yet, so giving up is a plain failure: the agent keeps the topped-up USDC for the next attempt.
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

/** Makes sure the agent holds `amount` USDC, redeeming exactly the shortfall from the owner's allowance if it is short. */
export const ensureUsdc = async (input: EnsureFundsInput): Promise<{ topUpTxHash?: Hex; topUpAmount?: bigint }> => {
  const chain = chainByKey(input.chain, input.live ?? true)
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
  await untilVisible(input, chain.usdc.address)
  return { topUpTxHash: redeemed.hash, topUpAmount: shortfall }
}

/** Pays `amount` USDC to `to` from the agent, topping up from the owner's allowance first when it is short. */
export const transferUsdc = async (input: EvmTransferInput): Promise<EvmTransferResult> => {
  // A zero transfer moves nothing the ledger counts but still burns the agent's gas.
  if (input.amount <= 0n) throw new TransferError('invalid_amount', 'A transfer must move a positive amount.')
  if (input.to.toLowerCase() === input.agent.address.toLowerCase())
    throw new TransferError('invalid_amount', 'The agent wallet cannot pay itself.')
  const chain = chainByKey(input.chain, input.live)
  await beforeSigning(() => requireGas(input))
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
