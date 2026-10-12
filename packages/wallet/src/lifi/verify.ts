/**
 * Reads a LI.FI swap transaction back before anything is signed. Only the Diamond's generic same-chain swap entry
 * points are accepted; their arguments must pay the agent, sell exactly the frozen token and amount, end in the frozen
 * buy token and promise at least the frozen minimum. Anything else (another facet, a bridge, an unknown selector) is
 * refused: an executable `eth_call` proves nothing about who receives the output.
 */
import { decodeFunctionData, parseAbi, type Hex } from 'viem'

const NATIVE = '0x0000000000000000000000000000000000000000'

const GENERIC_SWAPS = parseAbi([
  'struct SwapData { address callTo; address approveTo; address sendingAssetId; address receivingAssetId; uint256 fromAmount; bytes callData; bool requiresDeposit; }',
  'function swapTokensSingleV3ERC20ToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData _swapData)',
  'function swapTokensSingleV3ERC20ToNative(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData _swapData)',
  'function swapTokensSingleV3NativeToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData _swapData)',
  'function swapTokensMultipleV3ERC20ToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData[] _swapData)',
  'function swapTokensMultipleV3ERC20ToNative(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData[] _swapData)',
  'function swapTokensMultipleV3NativeToERC20(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData[] _swapData)',
  'function swapTokensGeneric(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, SwapData[] _swapData)',
])

/** What the frozen quote promises; the calldata must say the same. */
interface SwapPromise {
  readonly agent: string
  readonly sellToken: string
  readonly buyToken: string
  readonly sellAmount: bigint
  readonly buyAmountMin: bigint
  /** The transaction's native value. */
  readonly value: bigint
}

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

interface Step {
  readonly sendingAssetId: string
  readonly receivingAssetId: string
  readonly fromAmount: bigint
}

const decode = (data: Hex) => {
  try {
    return decodeFunctionData({ abi: GENERIC_SWAPS, data })
  } catch {
    // expected: a selector outside the generic swap entry points is a reason to refuse, reported by the caller.
    return undefined
  }
}

/** The reason the calldata breaks the promise, or undefined when it keeps it. */
export const swapCalldataMismatch = (data: Hex, promise: SwapPromise): string | undefined => {
  const call = decode(data)
  if (call === undefined) return 'The swap calls a LI.FI function the wallet does not run.'
  const [, , , receiver, minAmountOut, swapData] = call.args
  const steps: readonly Step[] = Array.isArray(swapData) ? swapData : [swapData]
  const first = steps[0]
  const last = steps.at(-1)
  if (first === undefined || last === undefined) return 'The swap has no steps.'
  if (!same(receiver, promise.agent)) return 'The swap pays someone other than the agent.'
  if (minAmountOut < promise.buyAmountMin) return 'The swap promises less than the quoted minimum.'
  if (!same(first.sendingAssetId, promise.sellToken) || first.fromAmount !== promise.sellAmount)
    return 'The swap sells a different token or amount than the quote.'
  if (!same(last.receivingAssetId, promise.buyToken)) return 'The swap buys a different token than the quote.'
  const nativeIn = same(promise.sellToken, NATIVE)
  if (promise.value !== (nativeIn ? promise.sellAmount : 0n)) return 'The swap sends unexpected native value.'
  const name = call.functionName
  if (name.endsWith('ERC20ToNative') && !same(promise.buyToken, NATIVE)) return 'The swap entry point does not fit.'
  if (name.includes('NativeToERC20') && !nativeIn) return 'The swap entry point does not fit.'
  return undefined
}
