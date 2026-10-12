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
 * Fee bounds for a signed transaction, in wei. The wallet's fee-ceiling check computes them, so the fee the signer signs
 * is the one the ceiling allowed.
 */
export interface TransactionFees {
  readonly gasLimit: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/**
 * The agent's signer: one Privy server wallet the owner owns, with this service as its policy-bound additional signer.
 * Every method takes a stable `operationKey`, reused as Privy's idempotency key, so a retry never signs twice. The
 * rails code against this interface; tests use a local viem account.
 */
export interface AgentSigner {
  readonly address: Address
  signTypedData(input: { chain: ChainKey; typedData: TypedDataJson; operationKey: string }): Promise<Hex>
  /** Signs and broadcasts a transaction from the agent wallet; resolves with the transaction hash. */
  sendTransaction(input: {
    chain: ChainKey
    to: Address
    data: Hex
    value?: bigint
    /** When given, the signed transaction carries exactly these fee bounds instead of the signer's own choice. */
    fees?: TransactionFees
    operationKey: string
  }): Promise<Hex>
  signAuthorization(input: {
    chain: ChainKey
    contract: Address
    nonce: number
    operationKey: string
  }): Promise<SignedAuthorization>
}
