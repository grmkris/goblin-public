import type { Hex } from 'viem'
import * as Data from 'effect/Data'
import { formatUnits } from '../amounts/index.ts'
import type { AgentSigner, TransactionFees } from '../contract/index.ts'
import { toHex } from './hex.ts'
import { field, quantity, waitForReceipt, type JsonRpc, type TxStatus, type WaitOptions } from './rpc.ts'
import type { ChainKey } from '../contract/index.ts'

export type EvmChain = Extract<ChainKey, 'base' | 'ethereum' | 'arbitrum'>

export type TransferFailure =
  | 'insufficient_funds'
  | 'no_gas'
  | 'allowance_exhausted'
  | 'reverted'
  | 'uncertain'
  | 'rpc_unavailable'
  | 'invalid_amount'
  | 'fee_ceiling'
  | 'unsupported'
  | 'bad_signature'

export class TransferError extends Data.TaggedError('TransferError')<{
  readonly code: TransferFailure
  readonly message: string
  /** True when money may have moved; the caller must not retry blind. */
  readonly uncertain: boolean
}> {
  constructor(code: TransferFailure, message: string, uncertain = false) {
    super({ code, message, uncertain })
  }
}

/** A revert message from `eth_call`, mapped to a sentence the owner and the model can act on. */
export const explainRevert = (message: string): { code: TransferFailure; text: string } => {
  if (message.includes('transfer-amount-exceeded'))
    return { code: 'allowance_exhausted', text: 'The allowance is used up for this period (enforced on-chain).' }
  if (/insufficient|exceeds balance/iu.test(message))
    return { code: 'insufficient_funds', text: 'The wallet does not hold enough for this transfer.' }
  return { code: 'reverted', text: 'The chain rejected the transaction.' }
}

export const simulate = async (
  rpc: JsonRpc,
  call: { from: string; to: string; data: Hex; value?: bigint },
): Promise<void> => {
  try {
    const { value, ...rest } = call
    await rpc('eth_call', [{ ...rest, ...(value === undefined ? {} : { value: `0x${value.toString(16)}` }) }, 'latest'])
  } catch (error) {
    const reason = explainRevert(error instanceof Error ? error.message : '')
    throw new TransferError(reason.code, reason.text)
  }
}

export interface SendContext {
  readonly agent: AgentSigner
  readonly chain: EvmChain
  readonly rpc: JsonRpc
  readonly wait?: WaitOptions | undefined
  /** Overrides the chain's `AGENT_FEE_CEILINGS` entry (wei). */
  readonly feeCeiling?: bigint | undefined
}

const GWEI = 1_000_000_000n

/**
 * The most one agent transaction may cost in fees (wei: padded gas estimate × max fee per gas): about $0.50 on Base and
 * Arbitrum and $7.50 on Ethereum at $2,500 ETH; a testnet uses its mainnet's ceiling. Above it nothing is signed. The
 * ledger does not reserve fees yet, so this ceiling is what bounds the gas one spend can burn.
 */
export const AGENT_FEE_CEILINGS: Readonly<Record<EvmChain, bigint>> = {
  base: 200_000n * GWEI,
  arbitrum: 200_000n * GWEI,
  ethereum: 3_000_000n * GWEI,
}

interface FeeCall {
  readonly from: string
  readonly to: string
  readonly data: Hex
  readonly value?: bigint | undefined
}

/** The padded gas estimate and EIP-1559 bounds (twice the base fee plus the tip) a call is signed with. */
const readFees = async (rpc: JsonRpc, call: FeeCall): Promise<TransactionFees> => {
  const { value, ...rest } = call
  const tx = { ...rest, ...(value === undefined ? {} : { value: `0x${value.toString(16)}` }) }
  const [gas, block, tip] = await Promise.all([
    rpc('eth_estimateGas', [tx]).then(quantity),
    rpc('eth_getBlockByNumber', ['latest', false]),
    // expected: a node without eth_maxPriorityFeePerGas is assumed to want a 0.1 gwei tip.
    rpc('eth_maxPriorityFeePerGas', []).then(quantity, () => GWEI / 10n),
  ])
  const baseFee = quantity(field(block, 'baseFeePerGas') ?? '0x0')
  return { gasLimit: (gas * 13n) / 10n, maxFeePerGas: baseFee * 2n + tip, maxPriorityFeePerGas: tip }
}

/**
 * Estimates a call's worst-case fee and refuses it above the chain's ceiling, before anything is signed. The bounds it
 * returns are the ones signed, so the ceiling binds the transaction rather than only predicting it.
 */
export const checkFeeCeiling = async (input: SendContext, call: FeeCall): Promise<TransactionFees> => {
  const ceiling = input.feeCeiling ?? AGENT_FEE_CEILINGS[input.chain]
  let fees: TransactionFees
  try {
    fees = await readFees(input.rpc, call)
  } catch {
    // expected: without a fee estimate the ceiling cannot be checked, so nothing is signed.
    throw new TransferError('rpc_unavailable', 'The chain did not answer the fee estimate; nothing was sent.')
  }
  const fee = fees.gasLimit * fees.maxFeePerGas
  if (fee > ceiling)
    throw new TransferError(
      'fee_ceiling',
      `The network fee (up to ${formatUnits(fee, 18)} ETH) is above the wallet's ceiling on this chain; nothing was sent.`,
    )
  return fees
}

export interface SendStep {
  /** Stable per step: the signer's idempotency key. */
  readonly key: string
  readonly to: string
  readonly data: Hex
  readonly value?: bigint
}

/** Simulates a call from the agent, checks its fee ceiling, signs and broadcasts it, and waits for the receipt. */
export const sendSimulated = async (input: SendContext, call: SendStep): Promise<{ hash: Hex; status: TxStatus }> => {
  const probe = {
    from: input.agent.address,
    to: call.to,
    data: call.data,
    ...(call.value === undefined ? {} : { value: call.value }),
  }
  await simulate(input.rpc, probe)
  const fees = await checkFeeCeiling(input, probe)
  let hash: Hex
  try {
    hash = toHex(
      await input.agent.sendTransaction({
        chain: input.chain,
        to: call.to,
        data: call.data,
        ...(call.value === undefined ? {} : { value: call.value }),
        fees,
        operationKey: call.key,
      }),
    )
  } catch {
    // expected: a signer error after simulation may follow a broadcast, so the transfer is reported as uncertain.
    throw new TransferError('uncertain', 'The signer did not confirm the transaction.', true)
  }
  const status = await waitForReceipt(input.rpc, hash, input.wait)
  return { hash, status }
}
