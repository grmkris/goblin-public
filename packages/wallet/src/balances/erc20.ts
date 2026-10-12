import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { toAddress, toHex } from './hex.ts'
import type { JsonRpc } from './rpc.ts'

const ERC20 = parseAbi(['function balanceOf(address owner) view returns (uint256)'])

/** `balanceOf(holder)` of an ERC-20 or TIP-20 token, in base units. */
export const erc20Balance = async (rpc: JsonRpc, tokenAddress: string, holder: string): Promise<bigint> => {
  const data = encodeFunctionData({ abi: ERC20, functionName: 'balanceOf', args: [toAddress(holder)] })
  const result = await rpc('eth_call', [{ to: tokenAddress, data }, 'latest'])
  return decodeFunctionResult({ abi: ERC20, functionName: 'balanceOf', data: toHex(String(result)) })
}
