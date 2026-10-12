/**
 * UserOperations through Pimlico's bundler, with its ERC-20 paymaster taking the gas in the chain's USDC: no account
 * of the wallet holds or spends ETH. Server only (the API key is the Worker's). An operation is prepared (nonce, gas,
 * the paymaster's USDC bound checked against a ceiling, the paymaster's data), signed by its account (the agent through
 * Privy, the owner in the browser), then submitted: the signature must recover to the sender over the DeleGator's
 * digest before anything is sent, and the hash is handed back before the receipt is awaited.
 */
import { encodeFunctionData, parseAbi, recoverAddress, toHex } from 'viem'
import { formatUnits } from '../amounts/index.ts'
import { field, JsonRpcError, quantity, type JsonRpc, type WaitOptions } from '../balances/rpc.ts'
import { toAddress, toHex as asHex } from '../balances/hex.ts'
import { explainRevert, TransferError } from '../balances/send.ts'
import type { AccountAbstraction, Chain } from '../chains/index.ts'
import type { Address, Hex } from '../contract/ids.ts'
import type { SignedAuthorization, UserOperation } from '../contract/signer.ts'
import { approvePaymaster, delegatorDigest, executeBatch, toBundlerJson, type Call } from '../userop/index.ts'

/** Pimlico's endpoint for one chain; the key travels only in this URL, which is never logged. */
export const pimlicoUrl = (chainId: number, apiKey: string): string =>
  `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(apiKey)}`

/**
 * A well-formed ECDSA signature for estimation: it recovers to some other address, so the DeleGator's
 * `validateUserOp` reports a failed validation instead of reverting on a malformed signature.
 */
const DUMMY_SIGNATURE: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c'

const ENTRY_POINT = parseAbi(['function getNonce(address sender, uint192 key) view returns (uint256)'])

export interface PrepareInput {
  readonly chain: Chain
  /** The chain's own node: the EntryPoint nonce is read there. */
  readonly node: JsonRpc
  readonly bundler: JsonRpc
  readonly sender: Address
  /**
   * The batch, without the paymaster's approval (prepare appends it). A function gets the fee bound it is built for:
   * first the ceiling (for the estimate), then the bound itself, so a top-up can pull exactly the gas it needs.
   */
  readonly calls: readonly Call[] | ((feeBound: bigint) => readonly Call[] | Promise<readonly Call[]>)
  /** The sender's 7702 authorization, when its code does not delegate to the DeleGator yet. */
  readonly authorization?: SignedAuthorization | undefined
  /** The most USDC (base units) the gas may cost; above it nothing is prepared. */
  readonly feeCeiling: bigint
}

/** An operation ready to sign: everything but the signature, and the USDC the paymaster may take at most. */
export interface PreparedUserOp {
  readonly op: UserOperation
  readonly authorization?: SignedAuthorization | undefined
  readonly entryPoint: Address
  readonly feeBound: bigint
}

export const aaOf = (chain: Chain): AccountAbstraction => {
  if (chain.aa === null)
    throw new TransferError('unsupported', `${chain.name} takes no UserOperations; nothing was sent.`)
  return chain.aa
}

/** A bundler call; its HTTP failures are `rpc_unavailable`, its refusals (an error object) the bundler's words. */
const ask = async (bundler: JsonRpc, method: string, params: readonly unknown[]): Promise<unknown> => {
  try {
    return await bundler(method, params)
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error
    if (error.code === undefined)
      throw new TransferError('rpc_unavailable', `The bundler did not answer (${method}); nothing was sent.`)
    const reason = explainRevert(error.message)
    throw new TransferError(reason.code, `${reason.text} (${error.message.slice(0, 160)})`)
  }
}

const big = (value: unknown): bigint => quantity(value)

/** Pimlico's USDC quote: the paymaster (checked against the chain's), its exchange rate and post-op gas. */
const quoteUsdc = async (input: PrepareInput, aa: AccountAbstraction) => {
  const answer = await ask(input.bundler, 'pimlico_getTokenQuotes', [
    { tokens: [input.chain.usdc.address] },
    aa.entryPoint,
    toHex(input.chain.id),
  ])
  const quotes = field(answer, 'quotes')
  const quote: unknown = Array.isArray(quotes) ? quotes[0] : undefined
  const paymaster = field(quote, 'paymaster')
  if (typeof paymaster !== 'string' || paymaster.toLowerCase() !== aa.paymaster.toLowerCase())
    throw new TransferError('rpc_unavailable', 'The bundler quoted an unexpected paymaster; nothing was sent.')
  return { exchangeRate: big(field(quote, 'exchangeRate')), postOpGas: big(field(quote, 'postOpGas')) }
}

/** Merges a paymaster answer (stub or final data) into the operation. */
const withPaymaster = (op: UserOperation, answer: unknown): UserOperation => {
  const paymaster = field(answer, 'paymaster')
  const data = field(answer, 'paymasterData')
  if (typeof paymaster !== 'string' || typeof data !== 'string')
    throw new TransferError('rpc_unavailable', 'The paymaster gave no data; nothing was sent.')
  const verification = field(answer, 'paymasterVerificationGasLimit')
  const postOp = field(answer, 'paymasterPostOpGasLimit')
  return {
    ...op,
    paymaster,
    paymasterData: data,
    ...(verification === undefined ? {} : { paymasterVerificationGasLimit: big(verification) }),
    ...(postOp === undefined ? {} : { paymasterPostOpGasLimit: big(postOp) }),
  }
}

/** The most USDC the paymaster can take: its required prefund plus post-op gas at the max fee, plus 20%. */
const feeBoundOf = (op: UserOperation, quote: { exchangeRate: bigint; postOpGas: bigint }): bigint => {
  const gas =
    op.verificationGasLimit +
    op.callGasLimit +
    (op.paymasterVerificationGasLimit ?? 0n) +
    (op.paymasterPostOpGasLimit ?? 0n) +
    op.preVerificationGas
  const wei = (gas + quote.postOpGas) * op.maxFeePerGas
  return (((wei * quote.exchangeRate) / 10n ** 18n) * 12n) / 10n + 1n
}

const params = (input: PrepareInput, aa: AccountAbstraction, op: UserOperation) => [
  toBundlerJson(op, input.authorization),
  aa.entryPoint,
  toHex(input.chain.id),
  { token: input.chain.usdc.address },
]

/** The paymaster gas limits an estimate carries, when it carries them. */
const pmGas = (gas: unknown) => {
  const verification = field(gas, 'paymasterVerificationGasLimit')
  const postOp = field(gas, 'paymasterPostOpGasLimit')
  return {
    ...(verification === undefined ? {} : { paymasterVerificationGasLimit: verification }),
    ...(postOp === undefined ? {} : { paymasterPostOpGasLimit: postOp }),
  }
}

/** Reads the nonce, prices the gas, estimates it, bounds the USDC fee and fetches the paymaster's data. */
export const prepareUserOp = async (input: PrepareInput): Promise<PreparedUserOp> => {
  const aa = aaOf(input.chain)
  const nonceData = encodeFunctionData({
    abi: ENTRY_POINT,
    functionName: 'getNonce',
    args: [toAddress(input.sender), 0n],
  })
  const nonce = big(
    await input.node('eth_call', [{ to: aa.entryPoint, data: nonceData }, 'latest']).catch(() => {
      throw new TransferError('rpc_unavailable', 'The chain did not answer the account nonce; nothing was sent.')
    }),
  )
  const quote = await quoteUsdc(input, aa)
  const fast = field(await ask(input.bundler, 'pimlico_getUserOperationGasPrice', []), 'fast')
  const { calls } = input
  const callsFor = typeof calls === 'function' ? calls : () => calls
  const batch = async (fee: bigint) =>
    executeBatch([...(await callsFor(fee)), approvePaymaster(input.chain, aa.paymaster, fee)])
  let op: UserOperation = {
    sender: input.sender,
    nonce,
    callData: await batch(input.feeCeiling),
    callGasLimit: 0n,
    verificationGasLimit: 0n,
    preVerificationGas: 0n,
    maxFeePerGas: big(field(fast, 'maxFeePerGas')),
    maxPriorityFeePerGas: big(field(fast, 'maxPriorityFeePerGas')),
    signature: DUMMY_SIGNATURE,
  }
  op = withPaymaster(op, await ask(input.bundler, 'pm_getPaymasterStubData', params(input, aa, op)))
  const gas = await ask(input.bundler, 'eth_estimateUserOperationGas', [
    toBundlerJson(op, input.authorization),
    aa.entryPoint,
  ])
  op = withPaymaster(
    {
      ...op,
      callGasLimit: big(field(gas, 'callGasLimit')),
      verificationGasLimit: big(field(gas, 'verificationGasLimit')),
      preVerificationGas: big(field(gas, 'preVerificationGas')),
    },
    { paymaster: op.paymaster, paymasterData: op.paymasterData, ...pmGas(gas) },
  )
  const feeBound = feeBoundOf(op, quote)
  if (feeBound > input.feeCeiling)
    throw new TransferError(
      'fee_ceiling',
      `Gas would cost up to ${formatUnits(feeBound, 6)} USDC, above the ${formatUnits(input.feeCeiling, 6)} USDC ceiling; nothing was signed.`,
    )
  op = { ...op, callData: await batch(feeBound) }
  op = withPaymaster(op, await ask(input.bundler, 'pm_getPaymasterData', params(input, aa, op)))
  return { op, authorization: input.authorization, entryPoint: aa.entryPoint, feeBound }
}

export type UserOpStatus = 'success' | 'reverted' | 'pending'

export interface SubmitInput {
  readonly chain: Chain
  readonly bundler: JsonRpc
  readonly prepared: PreparedUserOp
  readonly signature: Hex
  /** Called with the operation's hash once the bundler took it, before the receipt is awaited. */
  readonly onSubmitted?: ((userOpHash: Hex) => Promise<void> | void) | undefined
  readonly wait?: WaitOptions | undefined
}

export interface SubmittedUserOp {
  readonly userOpHash: Hex
  /** The bundle's transaction, once mined. */
  readonly txHash?: Hex | undefined
  /** `reverted`: mined, but the batch reverted (only the gas was charged); `pending`: not mined in time. */
  readonly status: UserOpStatus
}

const HASH = /^0x[0-9a-fA-F]{64}$/u
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The bundler's word on an operation: mined (and whether its batch ran), or not yet. */
export const userOpReceipt = async (
  bundler: JsonRpc,
  userOpHash: Hex,
): Promise<{ status: 'success' | 'reverted'; txHash?: Hex } | undefined> => {
  const receipt = await bundler('eth_getUserOperationReceipt', [userOpHash])
  if (typeof receipt !== 'object' || receipt === null) return undefined
  const txHash = field(field(receipt, 'receipt'), 'transactionHash')
  return {
    status: field(receipt, 'success') === true ? 'success' : 'reverted',
    ...(typeof txHash === 'string' && HASH.test(txHash) ? { txHash } : {}),
  }
}

/**
 * Hands the signed operation to the bundler once. A refusal (an error object) means nothing was sent; no answer at all
 * means it may have been taken, so the outcome is unknown and nothing retries it.
 */
const sendOnce = async (bundler: JsonRpc, op: UserOperation, prepared: PreparedUserOp): Promise<unknown> => {
  try {
    return await bundler('eth_sendUserOperation', [toBundlerJson(op, prepared.authorization), prepared.entryPoint])
  } catch (error) {
    if (error instanceof JsonRpcError && error.code !== undefined) {
      const reason = explainRevert(error.message)
      throw new TransferError(reason.code, `${reason.text} (${error.message.slice(0, 160)})`)
    }
    throw new TransferError('uncertain', 'The bundler did not answer the send; the operation may have gone out.', true)
  }
}

/** Sends a signed operation and waits for it; a bundler that refuses it means nothing was sent. */
export const submitUserOp = async (input: SubmitInput): Promise<SubmittedUserOp> => {
  const { prepared } = input
  const op: UserOperation = { ...prepared.op, signature: input.signature }
  const signer = await recoverAddress({
    hash: delegatorDigest(op, input.chain, prepared.entryPoint),
    signature: asHex(op.signature),
  })
  if (signer.toLowerCase() !== op.sender.toLowerCase())
    throw new TransferError('bad_signature', 'The signature is not from the sending account; nothing was sent.')
  const sent = await sendOnce(input.bundler, op, prepared)
  if (typeof sent !== 'string' || !HASH.test(sent))
    throw new TransferError('uncertain', 'The bundler gave no operation hash; it may have been sent.', true)
  const userOpHash = sent
  await input.onSubmitted?.(userOpHash)
  for (let attempt = 0; attempt < (input.wait?.attempts ?? 30); attempt += 1) {
    // expected: a bundler that misses one poll answers on the next; the operation is already submitted.
    const found = await userOpReceipt(input.bundler, userOpHash).catch(() => undefined)
    if (found !== undefined) return { userOpHash, ...found }
    await (input.wait?.sleep ?? sleep)(input.wait?.intervalMs ?? 1500)
  }
  return { userOpHash, status: 'pending' }
}
