import * as Data from 'effect/Data'
import type { ChainKey } from '../contract/index.ts'

export type EvmChain = Extract<ChainKey, 'base' | 'ethereum' | 'arbitrum'>

export type TransferFailure =
  | 'insufficient_funds'
  | 'allowance_exhausted'
  | 'reverted'
  | 'uncertain'
  | 'rpc_unavailable'
  | 'invalid_amount'
  | 'fee_ceiling'
  | 'unsupported'
  | 'bad_signature'
  | 'signer_refused'

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
