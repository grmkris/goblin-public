import type { Hex } from 'viem'
import type { AgentSigner } from '../contract/index.ts'
import { toHex } from './hex.ts'
import { waitForReceipt, type JsonRpc, type TxStatus, type WaitOptions } from './rpc.ts'
import type { ChainKey } from '../contract/index.ts'

export type EvmChain = Extract<ChainKey, 'base' | 'ethereum' | 'arbitrum'>

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
}

export interface SendStep {
  /** Stable per step: the signer's idempotency key. */
  readonly key: string
  readonly to: string
  readonly data: Hex
  readonly value?: bigint
}

/** Simulates a call from the agent, signs and broadcasts it, and waits for the receipt. */
export const sendSimulated = async (input: SendContext, call: SendStep): Promise<{ hash: Hex; status: TxStatus }> => {
  await simulate(input.rpc, {
    from: input.agent.address,
    to: call.to,
    data: call.data,
    ...(call.value === undefined ? {} : { value: call.value }),
  })
  let hash: Hex
  try {
    hash = toHex(
      await input.agent.sendTransaction({
        chain: input.chain,
        to: call.to,
        data: call.data,
        ...(call.value === undefined ? {} : { value: call.value }),
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
