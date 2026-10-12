/**
 * MetaMask Delegation Framework v1.3.0 (ERC-7710) encodings, ported from Sidequest's
 * `packages/sdk/src/delegation/index.ts` and made chain-parametric over `@goblin/wallet/chains` (the framework has the
 * same addresses on every chain the wallet knows). viem alone builds them; the tests cross-check them against
 * MetaMask's own `@metamask/delegation-core`.
 */
import {
  type Address,
  type Hex,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  hashStruct,
  hashTypedData,
  isAddress,
  parseAbi,
} from 'viem'
import type { Chain } from '../chains/index.ts'
import type { TypedDataJson } from '../contract/signer.ts'

/** The authority of a delegation granted by the account that holds the funds itself (no parent delegation). */
export const ROOT_AUTHORITY: Hex = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'

/** ERC-7579 execution mode: one call, revert on failure. */
const SINGLE_DEFAULT_MODE: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000'

export interface Caveat {
  readonly enforcer: Address
  readonly terms: Hex
  readonly args: Hex
}

export interface Delegation {
  readonly delegate: Address
  readonly delegator: Address
  readonly authority: Hex
  readonly caveats: readonly Caveat[]
  readonly salt: bigint
  readonly signature: Hex
}

/** The framework's EIP-712 types: what the delegator signs (a caveat's `args` and the signature are not signed). */
export const DELEGATION_TYPES = {
  Caveat: [
    { name: 'enforcer', type: 'address' },
    { name: 'terms', type: 'bytes' },
  ],
  Delegation: [
    { name: 'delegate', type: 'address' },
    { name: 'delegator', type: 'address' },
    { name: 'authority', type: 'bytes32' },
    { name: 'caveats', type: 'Caveat[]' },
    { name: 'salt', type: 'uint256' },
  ],
} as const

export const delegationManagerAbi = parseAbi([
  'struct Caveat { address enforcer; bytes terms; bytes args; }',
  'struct Delegation { address delegate; address delegator; bytes32 authority; Caveat[] caveats; uint256 salt; bytes signature; }',
  'function redeemDelegations(bytes[] permissionContexts, bytes32[] modes, bytes[] executionCallDatas)',
  'function disableDelegation(Delegation delegation)',
  'function disabledDelegations(bytes32 delegationHash) view returns (bool)',
])

const ERC20_TRANSFER = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

/** A permission context: `abi.encode(Delegation[])`, leaf to root (here one root delegation). */
const permissionContextAbi = [
  {
    type: 'tuple[]',
    components: [
      { name: 'delegate', type: 'address' },
      { name: 'delegator', type: 'address' },
      { name: 'authority', type: 'bytes32' },
      {
        name: 'caveats',
        type: 'tuple[]',
        components: [
          { name: 'enforcer', type: 'address' },
          { name: 'terms', type: 'bytes' },
          { name: 'args', type: 'bytes' },
        ],
      },
      { name: 'salt', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
  },
] as const

export const uint256 = (value: bigint): Hex => encodeAbiParameters([{ type: 'uint256' }], [value])

/** Hex in canonical lower case (packed addresses would otherwise keep their checksum casing). */
const lower = (value: Hex): Hex => `0x${value.slice(2).toLowerCase()}`

/** A caveat with its terms in canonical lower-case hex and no args. */
export const caveat = (enforcer: Address, terms: Hex): Caveat => ({ enforcer, terms: lower(terms), args: '0x' })

/** ERC20PeriodTransferEnforcer terms: packed token, amount per period, period length and start (seconds). */
export const periodTransferTerms = (token: Address, amount: bigint, period: number, start: number): Hex => {
  if (
    !isAddress(token) ||
    amount <= 0n ||
    !Number.isSafeInteger(period) ||
    period <= 0 ||
    !Number.isSafeInteger(start) ||
    start <= 0
  )
    throw new Error('invalid_terms: period transfer terms need a token, a positive amount, period and start')
  return lower(
    encodePacked(['address', 'uint256', 'uint256', 'uint256'], [token, amount, BigInt(period), BigInt(start)]),
  )
}

/** TimestampEnforcer terms: valid strictly before `until` (seconds), no lower bound. */
export const beforeTerms = (until: number): Hex => encodePacked(['uint128', 'uint128'], [0n, BigInt(until)])

/** AllowedCalldataEnforcer terms: `value` must appear at byte `start` of the call data. */
export const calldataTerms = (start: number, value: Hex): Hex =>
  encodePacked(['uint256', 'bytes'], [BigInt(start), value])

/** What the delegator signs: the delegation without its signature, caveats without their args. */
const signable = (x: Delegation) => ({
  delegate: x.delegate,
  delegator: x.delegator,
  authority: x.authority,
  caveats: x.caveats.map((item) => ({ enforcer: item.enforcer, terms: item.terms })),
  salt: x.salt,
})

/** The DelegationManager's EIP-712 domain on one chain. */
export const delegationDomain = (chain: Chain) =>
  ({ name: 'DelegationManager', version: '1', chainId: chain.id, verifyingContract: chain.delegation.manager }) as const

/** The EIP-712 struct hash: what the enforcers key their counters by and `disabledDelegations` is indexed by. */
export const delegationHash = (x: Delegation): Hex =>
  hashStruct({ data: signable(x), primaryType: 'Delegation', types: DELEGATION_TYPES })

/** The digest the delegator signs; the DeleGator on the delegator's account checks it (ERC-1271). */
export const delegationDigest = (chain: Chain, x: Delegation): Hex =>
  hashTypedData({
    domain: delegationDomain(chain),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: signable(x),
  })

/** The delegation as typed-data JSON (salt as a decimal string), for a wallet's `eth_signTypedData_v4`. */
export const delegationTypedData = (chain: Chain, x: Delegation): TypedDataJson => {
  const message = signable(x)
  return {
    domain: delegationDomain(chain),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: { ...message, caveats: message.caveats, salt: message.salt.toString() },
  }
}

/** A call the delegation executes from the delegator's account. */
export interface Execution {
  readonly target: Address
  readonly value: bigint
  readonly callData: Hex
}

/** An ERC-20 transfer of `amount` of `token` to `to`, as an execution. */
export const transferExecution = (token: Address, to: Address, amount: bigint): Execution => ({
  target: token,
  value: 0n,
  callData: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: 'transfer', args: [to, amount] }),
})

/** ERC-7710 `permissionContext`: the ABI-encoded chain (one root delegation) a redeemer passes to the manager. */
export const permissionContext = (signed: Delegation): Hex =>
  encodeAbiParameters(permissionContextAbi, [[{ ...signed, caveats: [...signed.caveats] }]])

/** `redeemDelegations` calldata: atomic ordered executions under one signed delegation, sent to the manager. */
export const redeemCallsCalldata = (signed: Delegation, executions: readonly Execution[]): Hex => {
  const context = permissionContext(signed)
  return encodeFunctionData({
    abi: delegationManagerAbi,
    functionName: 'redeemDelegations',
    args: [
      executions.map(() => context),
      executions.map(() => SINGLE_DEFAULT_MODE),
      executions.map((execution) =>
        encodePacked(['address', 'uint256', 'bytes'], [execution.target, execution.value, execution.callData]),
      ),
    ],
  })
}

/** `disableDelegation` calldata: only the delegator's account may send it; it revokes the delegation on-chain. */
export const disableCalldata = (x: Delegation): Hex =>
  encodeFunctionData({
    abi: delegationManagerAbi,
    functionName: 'disableDelegation',
    args: [{ ...x, caveats: [...x.caveats] }],
  })

/** The delegation as JSON-safe data (salt as a decimal string), for storage and the wire. */
export interface DelegationJson {
  readonly delegate: Address
  readonly delegator: Address
  readonly authority: Hex
  readonly caveats: readonly Caveat[]
  readonly salt: string
  readonly signature: Hex
}

export const toDelegationJson = (x: Delegation): DelegationJson => ({
  ...x,
  caveats: [...x.caveats],
  salt: x.salt.toString(),
})

export const fromDelegationJson = (x: DelegationJson): Delegation => {
  if (!/^\d{1,78}$/u.test(x.salt)) throw new Error('invalid_delegation: salt must be a decimal string')
  return { ...x, caveats: [...x.caveats], salt: BigInt(x.salt) }
}
