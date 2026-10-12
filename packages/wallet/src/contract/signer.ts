import type { Address, ChainKey, Hex } from './ids.ts'

/** EIP-712 typed data as JSON (bigints as decimal strings), the form Privy's wallet RPC takes. */
export interface TypedDataJson {
  readonly domain: Readonly<Record<string, unknown>>
  readonly types: Readonly<Record<string, readonly { readonly name: string; readonly type: string }[]>>
  readonly primaryType: string
  readonly message: Readonly<Record<string, unknown>>
}

/** A signed EIP-7702 authorization. */
export interface SignedAuthorization {
  readonly address: Address
  readonly chainId: number
  readonly nonce: number
  readonly r: Hex
  readonly s: Hex
  readonly yParity: number
}

/**
 * An ERC-4337 v0.7 UserOperation in its unpacked form (quantities as bigints). The DeleGator validates its signature
 * over its own EIP-712 `PackedUserOperation` digest (`@goblin/wallet/userop` `delegatorDigest`).
 */
export interface UserOperation {
  readonly sender: Address
  readonly nonce: bigint
  readonly callData: Hex
  readonly callGasLimit: bigint
  readonly verificationGasLimit: bigint
  readonly preVerificationGas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
  readonly paymaster?: Address
  readonly paymasterVerificationGasLimit?: bigint
  readonly paymasterPostOpGasLimit?: bigint
  readonly paymasterData?: Hex
  readonly signature: Hex
}

/**
 * The agent's signer: one Privy server wallet the owner owns, with this service as its policy-bound additional signer.
 * Every method takes a stable `operationKey`, reused as Privy's idempotency key, so a retry never signs twice. The
 * rails code against this interface; tests use a local viem account.
 */
export interface AgentSigner {
  readonly address: Address
  signTypedData(input: { chain: ChainKey; typedData: TypedDataJson; operationKey: string }): Promise<Hex>
  /**
   * Signs (never sends) a UserOperation from the agent's 7702-upgraded address: every EVM action of the agent is one,
   * its gas paid in USDC by the paymaster. Resolves with the signature over the DeleGator's digest.
   */
  signUserOperation(input: { chain: ChainKey; userOp: UserOperation; operationKey: string }): Promise<Hex>
  signAuthorization(input: {
    chain: ChainKey
    contract: Address
    nonce: number
    operationKey: string
  }): Promise<SignedAuthorization>
}
