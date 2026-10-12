/**
 * The agent's one way to act on an EVM chain: a UserOperation from its own 7702-upgraded address (MetaMask's DeleGator),
 * bundled by Pimlico, its gas paid in USDC by the ERC-20 paymaster. The agent never holds ETH. When it lacks the USDC a
 * batch spends plus the gas, the batch first redeems exactly that shortfall from the owner's ERC-7710 allowance, so the
 * top-up and the payment land together or not at all. Its first operation carries its 7702 authorization.
 */
import { formatUnits } from '../amounts/index.ts'
import { aaOf, prepareUserOp, submitUserOp, type UserOpStatus } from '../bundler/index.ts'
import { type Chain, chainByKey } from '../chains/index.ts'
import type { AgentSigner, SignedAuthorization } from '../contract/index.ts'
import type { Call } from '../userop/index.ts'
import { erc20Balance } from './erc20.ts'
import { JsonRpcError, quantity, type JsonRpc, type WaitOptions } from './rpc.ts'
import { TransferError, type EvmChain } from './send.ts'

/** How the agent pulls from the owner's allowance. */
export interface TopUp {
  /** Calldata for `DelegationManager.redeemDelegations` that moves `amount` of the stablecoin from owner to agent. */
  redeemCalldata(amount: bigint): Promise<string> | string
  /** What the enforcer still allows this period (base units). */
  available(): Promise<bigint>
}

/**
 * The most USDC (base units) one agent operation's gas may cost: $0.10 on Base and Arbitrum, $3 on Ethereum. Above it
 * nothing is signed. The ledger does not reserve gas, so this ceiling bounds what one spend can burn.
 */
export const AGENT_GAS_CEILINGS: Readonly<Record<EvmChain, bigint>> = {
  base: 100_000n,
  arbitrum: 100_000n,
  ethereum: 3_000_000n,
}

export interface AgentContext {
  /** Mainnets when true (`WALLET_LIVE=1`); testnets take no UserOperations. */
  readonly live: boolean
  readonly chain: EvmChain
  readonly agent: AgentSigner
  /** The chain's own node: balances, code, nonces. */
  readonly rpc: JsonRpc
  readonly bundler?: JsonRpc | undefined
  readonly topUp?: TopUp | undefined
  readonly wait?: WaitOptions | undefined
  /** Overrides the chain's `AGENT_GAS_CEILINGS` entry (USDC base units). */
  readonly feeCeiling?: bigint | undefined
  /** Called with the operation's hash once the bundler took it, before its receipt is awaited. */
  readonly onSubmitted?: ((userOpHash: string) => Promise<void> | void) | undefined
}

export interface AgentSend {
  /** Stable per step: the signer's idempotency key. */
  readonly key: string
  readonly calls: readonly Call[]
  /** USDC (base units) the calls spend from the agent's own balance. */
  readonly spends?: bigint
}

export interface AgentSent {
  readonly userOpHash: string
  readonly txHash?: string | undefined
  readonly status: UserOpStatus
  /** USDC pulled from the owner's allowance in the same operation: the shortfall plus the gas. */
  readonly toppedUp: bigint
}

/** A read before signing: a node that does not answer means nothing was sent. */
const before = async <A>(what: string, read: () => Promise<A>): Promise<A> => {
  try {
    return await read()
  } catch (error) {
    if (!(error instanceof JsonRpcError)) throw error
    throw new TransferError(
      'rpc_unavailable',
      `The chain did not answer before signing (${what}: ${error.message.slice(0, 120)}); nothing was sent.`,
    )
  }
}

/** The agent's 7702 authorization, when its code does not delegate to the DeleGator yet. */
const authorizationFor = async (
  input: AgentContext,
  chain: Chain,
  key: string,
): Promise<SignedAuthorization | undefined> => {
  const address = input.agent.address
  const code = String(await before('code', () => input.rpc('eth_getCode', [address, 'latest'])))
  if (code.toLowerCase() === `0xef0100${chain.delegation.delegator.slice(2)}`.toLowerCase()) return undefined
  const count = await before('nonce', () => input.rpc('eth_getTransactionCount', [address, 'pending']))
  return input.agent.signAuthorization({
    chain: input.chain,
    contract: chain.delegation.delegator,
    nonce: Number(quantity(count)),
    operationKey: `${key}:7702`,
  })
}

/**
 * The calls for a fee bound: first a redeem of exactly what the agent lacks (the spend plus the gas) when it lacks
 * anything, refused before signing when the allowance cannot cover it.
 */
const toppedUpCalls = async (input: AgentContext, chain: Chain, send: AgentSend) => {
  const spends = send.spends ?? 0n
  const held = await before('balance', () => erc20Balance(input.rpc, chain.usdc.address, input.agent.address))
  const { topUp } = input
  const available = topUp === undefined ? 0n : await before('allowance', () => topUp.available())
  const pulled = { amount: 0n }
  const callsFor = async (fee: bigint): Promise<readonly Call[]> => {
    const short = spends + fee - held
    pulled.amount = short > 0n ? short : 0n
    if (short <= 0n) return send.calls
    if (topUp === undefined)
      throw new TransferError(
        'insufficient_funds',
        `The agent wallet holds ${formatUnits(held, 6)} USDC; it needs ${formatUnits(spends + fee, 6)} with the gas.`,
      )
    if (short > available)
      throw new TransferError('allowance_exhausted', 'The allowance is used up for this period (enforced on-chain).')
    const redeem: Call = { target: chain.delegation.manager, value: 0n, callData: await topUp.redeemCalldata(short) }
    return [redeem, ...send.calls]
  }
  return { callsFor, pulled }
}

/** Sends one batch as a UserOperation from the agent and waits for it (`pending` when not mined in time). */
export const sendCalls = async (input: AgentContext, send: AgentSend): Promise<AgentSent> => {
  const chain = chainByKey(input.chain, input.live)
  aaOf(chain)
  const { bundler } = input
  if (bundler === undefined) throw new TransferError('unsupported', 'No bundler is configured; nothing was sent.')
  const { callsFor, pulled } = await toppedUpCalls(input, chain, send)
  const authorization = await authorizationFor(input, chain, send.key)
  const prepared = await prepareUserOp({
    chain,
    node: input.rpc,
    bundler,
    sender: input.agent.address,
    calls: callsFor,
    authorization,
    feeCeiling: input.feeCeiling ?? AGENT_GAS_CEILINGS[input.chain],
  })
  let signature: string
  try {
    signature = await input.agent.signUserOperation({
      chain: input.chain,
      userOp: prepared.op,
      operationKey: `${send.key}:userop`,
    })
  } catch {
    // expected: a signer that refuses (its policy) or does not answer has signed nothing that can be sent.
    throw new TransferError('signer_refused', "The agent's signer did not sign the operation; nothing was sent.")
  }
  const sent = await submitUserOp({
    chain,
    bundler,
    prepared,
    signature,
    onSubmitted: input.onSubmitted,
    wait: input.wait,
  })
  return { ...sent, toppedUp: pulled.amount }
}
