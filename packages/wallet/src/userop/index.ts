/**
 * ERC-4337 v0.7 UserOperations for MetaMask's EIP7702StatelessDeleGator: a 7702-upgraded owner or agent address sends
 * every EVM action as one batched UserOperation, and Pimlico's ERC-20 paymaster takes the gas in USDC. Pure encoders,
 * safe in the browser: the batch call data, the v0.7 packing, the DeleGator's EIP-712 digest (it validates its own
 * typed data, not the EntryPoint's userOpHash), and the JSON forms the bundler and Privy take.
 */
import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  hashTypedData,
  pad,
  parseAbi,
  toHex,
} from 'viem'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { formatUnits } from '../amounts/index.ts'
import { toAddress, toHex as asHex } from '../balances/hex.ts'
import type { AccountAbstraction, Chain } from '../chains/index.ts'
import { canonicalJson } from '../contract/hash.ts'
import { Address, Hex } from '../contract/ids.ts'
import type { SignedAuthorization, TypedDataJson, UserOperation } from '../contract/signer.ts'

export type { UserOperation } from '../contract/signer.ts'

/** One call of a batch. */
export interface Call {
  readonly target: Address
  readonly value: bigint
  readonly callData: Hex
}

const EXECUTE = parseAbi(['function execute(bytes32 mode, bytes executionCalldata) payable'])
/** ERC-7579 batch call type with the default (revert on failure) exec type: every call lands, or none. */
const BATCH_MODE: Hex = '0x0100000000000000000000000000000000000000000000000000000000000000'
const CALLS = [
  {
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  },
] as const

/** The DeleGator's `execute(batch mode, calls)`: the call data of every UserOperation the wallet sends. */
export const executeBatch = (calls: readonly Call[]): Hex =>
  encodeFunctionData({
    abi: EXECUTE,
    functionName: 'execute',
    args: [
      asHex(BATCH_MODE),
      encodeAbiParameters(CALLS, [
        calls.map((call) => ({ target: toAddress(call.target), value: call.value, callData: asHex(call.callData) })),
      ]),
    ],
  })

/** The calls of a batch `executeBatch` encoded; undefined when the call data is anything else. */
export function decodeBatch(callData: Hex): Call[] | undefined {
  try {
    const { args } = decodeFunctionData({ abi: EXECUTE, data: asHex(callData) })
    if (args[0].toLowerCase() !== BATCH_MODE) return undefined
    const [calls] = decodeAbiParameters(CALLS, args[1])
    return calls.map((call) => ({ target: call.target, value: call.value, callData: call.callData }))
  } catch {
    // expected: call data that is not a DeleGator batch reads as no batch; the caller refuses it.
    return undefined
  }
}

const u128 = (value: bigint) => pad(toHex(value), { size: 16 })

/** v0.7 packing: verification gas limit, then call gas limit, 16 bytes each. */
export const accountGasLimits = (op: UserOperation) => concat([u128(op.verificationGasLimit), u128(op.callGasLimit)])

/** v0.7 packing: max priority fee, then max fee, 16 bytes each. */
export const gasFees = (op: UserOperation) => concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)])

/** v0.7 packing: paymaster, its verification and post-op gas limits, then its data; `0x` without a paymaster. */
export const paymasterAndData = (op: UserOperation) =>
  op.paymaster === undefined
    ? '0x'
    : concat([
        toAddress(op.paymaster),
        u128(op.paymasterVerificationGasLimit ?? 0n),
        u128(op.paymasterPostOpGasLimit ?? 0n),
        asHex(op.paymasterData ?? '0x'),
      ])

const PACKED = [
  { name: 'sender', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'initCode', type: 'bytes' },
  { name: 'callData', type: 'bytes' },
  { name: 'accountGasLimits', type: 'bytes32' },
  { name: 'preVerificationGas', type: 'uint256' },
  { name: 'gasFees', type: 'bytes32' },
  { name: 'paymasterAndData', type: 'bytes' },
  { name: 'entryPoint', type: 'address' },
] as const

/**
 * The typed data the DeleGator checks in `validateUserOp`: its own domain (name, version 1, the chain, the account
 * itself as verifying contract) over the packed operation and the EntryPoint. The owner signs exactly this.
 */
export const delegatorTypedData = (op: UserOperation, chain: Pick<Chain, 'id'>, entryPoint: Address) => ({
  domain: {
    name: 'EIP7702StatelessDeleGator',
    version: '1',
    chainId: chain.id,
    verifyingContract: toAddress(op.sender),
  },
  types: { PackedUserOperation: PACKED },
  primaryType: 'PackedUserOperation' as const,
  message: {
    sender: toAddress(op.sender),
    nonce: op.nonce,
    initCode: asHex('0x'),
    callData: asHex(op.callData),
    accountGasLimits: accountGasLimits(op),
    preVerificationGas: op.preVerificationGas,
    gasFees: gasFees(op),
    paymasterAndData: paymasterAndData(op),
    entryPoint: toAddress(entryPoint),
  },
})

/** The digest the operation's signature must recover over to the sender. */
export const delegatorDigest = (op: UserOperation, chain: Pick<Chain, 'id'>, entryPoint: Address) =>
  hashTypedData(delegatorTypedData(op, chain, entryPoint))

/** A 7702 authorization as the bundler takes it in `eip7702Auth` (hex quantities). */
export const bundlerAuthorization = (auth: SignedAuthorization) => ({
  address: auth.address,
  chainId: toHex(auth.chainId),
  nonce: toHex(auth.nonce),
  r: auth.r,
  s: auth.s,
  yParity: toHex(auth.yParity),
})

/** The bundler's JSON form (v0.7, unpacked, hex quantities), with the 7702 authorization when the op carries one. */
export const toBundlerJson = (op: UserOperation, authorization?: SignedAuthorization) => ({
  sender: op.sender,
  nonce: toHex(op.nonce),
  callData: op.callData,
  callGasLimit: toHex(op.callGasLimit),
  verificationGasLimit: toHex(op.verificationGasLimit),
  preVerificationGas: toHex(op.preVerificationGas),
  maxFeePerGas: toHex(op.maxFeePerGas),
  maxPriorityFeePerGas: toHex(op.maxPriorityFeePerGas),
  ...(op.paymaster === undefined
    ? {}
    : {
        paymaster: op.paymaster,
        paymasterVerificationGasLimit: toHex(op.paymasterVerificationGasLimit ?? 0n),
        paymasterPostOpGasLimit: toHex(op.paymasterPostOpGasLimit ?? 0n),
        paymasterData: op.paymasterData ?? '0x',
      }),
  signature: op.signature,
  ...(authorization === undefined ? {} : { eip7702Auth: bundlerAuthorization(authorization) }),
})

const NO_PAYMASTER: Address = '0x0000000000000000000000000000000000000000'

/** Privy's `eth_signUserOperation` form: snake case, hex quantities, the paymaster fields always present. */
export const toPrivyJson = (op: UserOperation) => ({
  sender: op.sender,
  nonce: toHex(op.nonce),
  call_data: op.callData,
  call_gas_limit: toHex(op.callGasLimit),
  verification_gas_limit: toHex(op.verificationGasLimit),
  pre_verification_gas: toHex(op.preVerificationGas),
  max_fee_per_gas: toHex(op.maxFeePerGas),
  max_priority_fee_per_gas: toHex(op.maxPriorityFeePerGas),
  paymaster: op.paymaster ?? NO_PAYMASTER,
  paymaster_data: op.paymasterData ?? '0x',
  paymaster_verification_gas_limit: toHex(op.paymasterVerificationGasLimit ?? 0n),
  paymaster_post_op_gas_limit: toHex(op.paymasterPostOpGasLimit ?? 0n),
})

const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

/** The paymaster's USDC allowance for one operation: every batch the wallet sends carries it. */
export const approvePaymaster = (chain: Chain, paymaster: Address, amount: bigint): Call => ({
  target: chain.usdc.address,
  value: 0n,
  callData: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [toAddress(paymaster), amount] }),
})

/** The most USDC (base units) the owner's one-time upgrade may pay for its gas, per chain: Ethereum's costs far more. */
export const UPGRADE_FEE_CEILINGS: Readonly<Record<'base' | 'ethereum' | 'arbitrum', bigint>> = {
  base: 100_000n,
  arbitrum: 100_000n,
  ethereum: 3_000_000n,
}

const Decimal = Schema.String.check(Schema.isPattern(/^\d{1,78}$/u))
const Word = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/u))

/** The owner's upgrade operation as the Worker sends it: `delegatorTypedData` as JSON, bigints as decimal strings. */
const OwnerUpgradeTypedData = Schema.Struct({
  domain: Schema.Struct({
    name: Schema.Literal('EIP7702StatelessDeleGator'),
    version: Schema.Literal('1'),
    chainId: Schema.Number,
    verifyingContract: Address,
  }),
  types: Schema.Unknown,
  primaryType: Schema.Literal('PackedUserOperation'),
  message: Schema.Struct({
    sender: Address,
    nonce: Decimal,
    initCode: Schema.Literal('0x'),
    callData: Hex,
    accountGasLimits: Word,
    preVerificationGas: Decimal,
    gasFees: Word,
    paymasterAndData: Hex,
    entryPoint: Address,
  }),
})
const decodeOwnerUpgrade = Schema.decodeUnknownOption(OwnerUpgradeTypedData)

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const sameCall = (a: Call, b: Call | undefined): boolean =>
  b !== undefined && same(a.target, b.target) && a.value === b.value && same(a.callData, b.callData)

/** A review's refusal: `code: what; nothing was signed`. */
const refusal = (code: string) => (what: string) => new Error(`${code}: ${what}; nothing was signed`)

/**
 * The amount of the batch's last call, USDC `approve(paymaster, amount)`, after exactly `expected` before it; anything
 * else in the batch is refused.
 */
const paymasterApproval = (
  callData: Hex,
  chain: Chain,
  aa: AccountAbstraction,
  expected: readonly Call[],
  mismatch: (what: string) => Error,
): bigint => {
  const foreign =
    expected.length === 0
      ? 'the operation does more than approve its gas in USDC'
      : 'the operation does more than you asked'
  const calls = decodeBatch(callData)
  if (
    calls === undefined ||
    calls.length !== expected.length + 1 ||
    expected.some((call, index) => !sameCall(call, calls[index]))
  )
    throw mismatch(foreign)
  const call = calls.at(-1)
  if (call === undefined || !same(call.target, chain.usdc.address) || call.value !== 0n) throw mismatch(foreign)
  let approval: ReturnType<typeof decodeFunctionData<typeof ERC20>>
  try {
    approval = decodeFunctionData({ abi: ERC20, data: asHex(call.callData) })
  } catch {
    // expected: a USDC call that is not `approve` is refused like any other foreign call.
    throw mismatch(foreign)
  }
  const [spender, amount] = approval.args
  if (!same(spender, aa.paymaster)) throw mismatch("the gas approval is not for the chain's paymaster")
  return amount
}

/** What the owner agreed to before the upgrade is signed: the chain, their own address, the most USDC for gas. */
export interface OwnerUpgradeChoice {
  readonly chain: Chain
  readonly owner: Address
  /** USDC base units; `UPGRADE_FEE_CEILINGS` per chain. */
  readonly feeCeiling: bigint
}

export interface ReviewedOwnerUpgrade {
  /** Rebuilt from the checked fields only: what the owner signs, never the server's object itself. */
  readonly typedData: TypedDataJson
  /** The most USDC (base units) the paymaster may take for the gas: the batch's approval. */
  readonly maxFee: bigint
}

/** The owner's operation checked against what they agreed to: `calls`, then the gas approval, nothing else. */
const reviewOwner = (
  typedData: unknown,
  choice: OwnerUpgradeChoice,
  calls: readonly Call[],
  mismatch: (what: string) => Error,
): ReviewedOwnerUpgrade => {
  const { chain, owner } = choice
  if (chain.aa === null) throw mismatch(`${chain.name} takes no UserOperations`)
  const draft = Option.getOrUndefined(decodeOwnerUpgrade(typedData))
  if (draft === undefined || canonicalJson(draft.types) !== canonicalJson({ PackedUserOperation: PACKED }))
    throw mismatch('the draft is not a DeleGator UserOperation')
  const { domain, message } = draft
  if (domain.chainId !== chain.id || !same(domain.verifyingContract, owner) || !same(message.sender, owner))
    throw mismatch(`the operation is not your account's on ${chain.name}`)
  if (
    !same(message.entryPoint, chain.aa.entryPoint) ||
    !same(message.paymasterAndData.slice(0, 42), chain.aa.paymaster)
  )
    throw mismatch(`the operation names another EntryPoint or paymaster than ${chain.name}'s`)
  const maxFee = paymasterApproval(message.callData, chain, chain.aa, calls, mismatch)
  if (maxFee > choice.feeCeiling)
    throw mismatch(
      `its gas could cost up to ${formatUnits(maxFee, 6)} USDC, above the ${formatUnits(choice.feeCeiling, 6)} USDC ceiling`,
    )
  return {
    typedData: { domain, types: { PackedUserOperation: PACKED }, primaryType: 'PackedUserOperation', message },
    maxFee,
  }
}

/**
 * Checks the owner's EIP-7702 upgrade operation before they sign it: the DeleGator's domain on this chain with the
 * owner's own address as verifying contract, the owner as sender, the chain's EntryPoint and paymaster, and a batch
 * that only approves that paymaster for at most the fee ceiling in USDC. Throws `upgrade_mismatch: …` otherwise.
 */
export const reviewOwnerUpgrade = (typedData: unknown, choice: OwnerUpgradeChoice): ReviewedOwnerUpgrade =>
  reviewOwner(typedData, choice, [], refusal('upgrade_mismatch'))

/**
 * Checks any other operation of the owner's own account the same way (a subscription's cancellation): its batch must
 * be exactly `calls`, rebuilt in the browser from what the owner chose, then the gas approval. Throws
 * `operation_mismatch: …` otherwise.
 */
export const reviewOwnerCalls = (
  typedData: unknown,
  choice: OwnerUpgradeChoice,
  calls: readonly Call[],
): ReviewedOwnerUpgrade => reviewOwner(typedData, choice, calls, refusal('operation_mismatch'))
