// Read-only evidence for an operation whose outcome is unknown: did its transaction land, or was its x402
// authorization used? Each answer is one RPC read; nothing here signs, sends or retries a payment.
import { encodeFunctionData, parseAbi } from 'viem'
import { toAddress, toHex } from './hex.ts'
import type { JsonRpc } from './rpc.ts'

const EIP3009 = parseAbi(['function authorizationState(address authorizer, bytes32 nonce) view returns (bool)'])

/** A transaction's fate as the chain has it now: mined and succeeded, mined and reverted, or not (yet) on chain. */
export type TransactionFate = 'success' | 'reverted' | 'not_found'

export const transactionFate = async (rpc: JsonRpc, hash: string): Promise<TransactionFate> => {
  const receipt = await rpc('eth_getTransactionReceipt', [hash])
  if (typeof receipt !== 'object' || receipt === null) return 'not_found'
  return 'status' in receipt && receipt.status === '0x1' ? 'success' : 'reverted'
}

/**
 * Whether an EIP-3009 authorization has been used on `token` (USDC's `authorizationState`): true once a transfer with
 * it settled, so the payment happened whatever the service answered.
 */
export const authorizationUsed = async (
  rpc: JsonRpc,
  token: string,
  authorization: { readonly from: string; readonly nonce: string },
): Promise<boolean> => {
  const data = encodeFunctionData({
    abi: EIP3009,
    functionName: 'authorizationState',
    args: [toAddress(authorization.from), toHex(authorization.nonce)],
  })
  const answer = await rpc('eth_call', [{ to: toAddress(token), data }, 'latest'])
  return typeof answer === 'string' && /^0x0*1$/u.test(answer)
}
