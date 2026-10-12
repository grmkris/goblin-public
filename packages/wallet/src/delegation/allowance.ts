/**
 * The owner's allowance to the agent as one ERC-7710 delegation, ported from the allowance branch of Sidequest's
 * `packages/sdk/src/delegation/grants.ts` (`buildGrant`, `assertGrant`) and explore's `reviewAgentGrant`.
 *
 * - `allowance`: from the owner's 7702-upgraded account to the agent wallet: USDC `transfer` only (AllowedTargets,
 *   AllowedMethods, no value), the agent as the only recipient (AllowedCalldata), at most `amount` per period
 *   (ERC20PeriodTransfer), valid until `expiresAt` (Timestamp). The chain enforces every term.
 * - `allowance-once`: exactly one transfer of exactly `amount` to the agent, within ten minutes (LimitedCalls,
 *   AllowedCalldata on the whole call, ERC20TransferAmount).
 *
 * The browser never signs what the server says: `reviewAllowance` rebuilds the delegation from what the owner chose and
 * compares hashes first.
 */
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type Address, type Hex, isAddressEqual, pad, recoverTypedDataAddress, toFunctionSelector } from 'viem'
import { formatUnits, parseUnits } from '../amounts/index.ts'
import type { Chain } from '../chains/index.ts'
import { canonicalJson } from '../contract/hash.ts'
import type { TypedDataJson } from '../contract/signer.ts'
import {
  DELEGATION_TYPES,
  type Delegation,
  type DelegationJson,
  ROOT_AUTHORITY,
  beforeTerms,
  calldataTerms,
  caveat,
  delegationDomain,
  delegationHash,
  delegationTypedData,
  fromDelegationJson,
  periodTransferTerms,
  redeemCallsCalldata,
  toDelegationJson,
  transferExecution,
  uint256,
} from './encoding.ts'

/** The allowance's period: the owner sets an hourly amount. */
export const ALLOWANCE_PERIOD_S = 3600
/** A one-off allowance is redeemable for ten minutes. */
export const ONCE_VALIDITY_S = 600
export const MAX_ALLOWANCE_DAYS = 30
/** The period starts a minute before it is prepared, so a redemption right after signing never meets an earlier block. */
const START_LEAD_S = 60
/** How old a prepared allowance may be when the owner reviews it. */
const REVIEW_WINDOW_S = 300

const TRANSFER_SELECTOR = toFunctionSelector('function transfer(address to, uint256 amount)')

export type AllowanceSpec =
  | {
      readonly kind: 'allowance'
      readonly chain: Chain
      readonly owner: Address
      readonly agent: Address
      /** Base units of the chain's USDC per period. */
      readonly amount: bigint
      readonly period: number
      /** Seconds: the first period's start. */
      readonly start: number
      readonly expiresAt: number
      readonly salt: bigint
    }
  | {
      readonly kind: 'allowance-once'
      readonly chain: Chain
      readonly owner: Address
      readonly agent: Address
      readonly amount: bigint
      readonly start: number
      readonly salt: bigint
    }

export const allowanceExpiry = (spec: AllowanceSpec): number =>
  spec.kind === 'allowance' ? spec.expiresAt : spec.start + ONCE_VALIDITY_S

/** The delegation for a spec: the caveats in Sidequest's order, so equal specs give equal hashes. */
export const buildAllowance = (spec: AllowanceSpec): Delegation => {
  const { chain } = spec
  const e = chain.delegation.enforcers
  const token = chain.usdc.address
  if (spec.amount <= 0n) throw new Error('invalid_allowance: the amount must be positive')
  if (spec.salt < 0n || !Number.isSafeInteger(spec.start) || spec.start <= 0)
    throw new Error('invalid_allowance: a salt and a start are required')
  const caveats = [
    caveat(e.allowedTargets, token),
    caveat(e.allowedMethods, TRANSFER_SELECTOR),
    caveat(e.valueLte, uint256(0n)),
    caveat(e.timestamp, beforeTerms(allowanceExpiry(spec))),
  ]
  if (spec.kind === 'allowance-once') caveats.push(caveat(e.limitedCalls, uint256(1n)))
  caveats.push(caveat(e.allowedCalldata, calldataTerms(4, pad(spec.agent, { size: 32 }))))
  if (spec.kind === 'allowance')
    caveats.push(caveat(e.erc20PeriodTransfer, periodTransferTerms(token, spec.amount, spec.period, spec.start)))
  else {
    caveats.push(
      caveat(e.allowedCalldata, calldataTerms(0, transferExecution(token, spec.agent, spec.amount).callData)),
    )
    caveats.push(caveat(e.erc20TransferAmount, `${token}${uint256(spec.amount).slice(2)}`))
  }
  return {
    delegator: spec.owner,
    delegate: spec.agent,
    authority: ROOT_AUTHORITY,
    caveats,
    salt: spec.salt,
    signature: '0x',
  }
}

/** Refuses a delegation that differs from the spec's: extra caveats, changed terms, args, another authority. */
export const assertAllowance = (spec: AllowanceSpec, grant: Delegation): void => {
  if (
    grant.caveats.some((item) => item.args !== '0x') ||
    delegationHash(grant) !== delegationHash(buildAllowance(spec))
  )
    throw new Error('allowance_mismatch: the delegation differs from the allowance the owner chose')
}

/** What the owner chose on the allowance screen. */
export interface AllowanceChoice {
  readonly chain: Chain
  readonly owner: Address
  readonly agent: Address
  /** USD per hour as a decimal string; one USDC base unit per micro-dollar. */
  readonly perHour: string
  readonly days: number
}

const checkDays = (days: number): void => {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_ALLOWANCE_DAYS)
    throw new Error(`invalid_allowance: days must be 1 to ${MAX_ALLOWANCE_DAYS}`)
}

/** The spec of a choice prepared at `nowS` with `salt`. */
export const choiceSpec = (choice: AllowanceChoice, nowS: number, salt: bigint): AllowanceSpec => {
  checkDays(choice.days)
  return {
    kind: 'allowance',
    chain: choice.chain,
    owner: choice.owner,
    agent: choice.agent,
    amount: parseUnits(choice.perHour, choice.chain.usdc.decimals),
    period: ALLOWANCE_PERIOD_S,
    start: nowS - START_LEAD_S,
    expiresAt: nowS + choice.days * 86_400,
    salt,
  }
}

/** A delegation prepared for the owner to sign, kept by the server until it comes back signed. */
export interface PreparedAllowance {
  readonly chainId: number
  readonly typedData: TypedDataJson
  readonly delegationHash: Hex
  readonly delegation: DelegationJson
  readonly perHour: string
  readonly expiresAt: string
}

const randomSalt = (): bigint =>
  BigInt(
    `0x${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')}`,
  )

/** `POST /api/allowance/prepare`: the exact delegation for the owner to sign, and its hash. */
export const prepareAllowance = (
  choice: AllowanceChoice,
  nowMs: number,
  salt: bigint = randomSalt(),
): PreparedAllowance => {
  const spec = choiceSpec(choice, Math.floor(nowMs / 1000), salt)
  const delegation = buildAllowance(spec)
  return {
    chainId: choice.chain.id,
    typedData: delegationTypedData(choice.chain, delegation),
    delegationHash: delegationHash(delegation),
    delegation: toDelegationJson(delegation),
    perHour: formatUnits(spec.amount, choice.chain.usdc.decimals),
    expiresAt: new Date(allowanceExpiry(spec) * 1000).toISOString(),
  }
}

/** A signed allowance: what the agent redeems from. */
export interface SignedAllowance {
  readonly delegation: DelegationJson
  readonly delegationHash: Hex
  readonly perHour: string
  readonly expiresAt: string
}

/**
 * `POST /api/allowance/confirm`: checks that the prepared delegation still hashes to itself and that the owner's
 * signature recovers to the owner (the stateless DeleGator checks the account's own key), then attaches it.
 */
export const confirmAllowance = async (
  chain: Chain,
  prepared: PreparedAllowance,
  owner: Address,
  signature: Hex,
): Promise<SignedAllowance> => {
  const delegation = fromDelegationJson(prepared.delegation)
  if (prepared.chainId !== chain.id || delegationHash(delegation) !== prepared.delegationHash)
    throw new Error('allowance_mismatch: the prepared allowance changed')
  if (!isAddressEqual(delegation.delegator, owner)) throw new Error('allowance_mismatch: another owner prepared this')
  const recovered = await recoverTypedDataAddress({
    domain: delegationDomain(chain),
    types: DELEGATION_TYPES,
    primaryType: 'Delegation',
    message: {
      delegate: delegation.delegate,
      delegator: delegation.delegator,
      authority: delegation.authority,
      caveats: delegation.caveats.map((item) => ({ enforcer: item.enforcer, terms: item.terms })),
      salt: delegation.salt,
    },
    signature,
  })
  if (!isAddressEqual(recovered, owner)) throw new Error('invalid_signature: the signature is not the owner wallet')
  return {
    delegation: { ...prepared.delegation, signature },
    delegationHash: prepared.delegationHash,
    perHour: prepared.perHour,
    expiresAt: prepared.expiresAt,
  }
}

/** The agent's redemption: `amount` base units of the chain's USDC from the owner to the agent. */
export const allowanceRedeemCalldata = (chain: Chain, signed: DelegationJson, amount: bigint): Hex => {
  const delegation = fromDelegationJson(signed)
  if (delegation.signature === '0x') throw new Error('invalid_delegation: the allowance is not signed')
  return redeemCallsCalldata(delegation, [transferExecution(chain.usdc.address, delegation.delegate, amount)])
}

const Hex32 = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]*$/u))
const AddressSchema = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u))
const DraftMessage = Schema.Struct({
  delegate: AddressSchema,
  delegator: AddressSchema,
  authority: Hex32,
  caveats: Schema.Array(Schema.Struct({ enforcer: AddressSchema, terms: Hex32 })),
  salt: Schema.String.check(Schema.isPattern(/^\d{1,78}$/u)),
})
const Draft = Schema.Struct({
  domain: Schema.Record(Schema.String, Schema.Unknown),
  primaryType: Schema.Literal('Delegation'),
  message: DraftMessage,
})
const decodeDraft = Schema.decodeUnknownOption(Draft)

/** The period's start, read from the draft's ERC20PeriodTransfer terms (the last of their four words). */
const draftStart = (chain: Chain, caveats: readonly { enforcer: string; terms: string }[]): number => {
  const period = caveats.find(
    (item) => item.enforcer.toLowerCase() === chain.delegation.enforcers.erc20PeriodTransfer.toLowerCase(),
  )
  if (period === undefined || period.terms.length !== 2 + 2 * (20 + 32 * 3))
    throw new Error('allowance_mismatch: the allowance has no period terms')
  return Number(BigInt(`0x${period.terms.slice(-64)}`))
}

export interface ReviewedAllowance {
  readonly delegationHash: Hex
  /** Exactly what to sign: the rebuilt delegation, not the server's. */
  readonly typedData: TypedDataJson
  readonly description: {
    readonly chainId: number
    readonly token: string
    readonly perHour: string
    readonly periodSeconds: number
    readonly startsAt: string
    readonly expiresAt: string
    readonly agent: Address
  }
}

/**
 * Rebuild-and-compare before the owner signs: the server's draft must be, byte for byte, the allowance the owner
 * chose (chain, owner, agent, amount per hour, days), freshly prepared. Throws `allowance_mismatch` otherwise.
 */
export const reviewAllowance = (
  draft: { readonly typedData: unknown; readonly delegationHash: string },
  choice: AllowanceChoice,
  nowMs: number,
): ReviewedAllowance => {
  const decoded = Option.getOrUndefined(decodeDraft(draft.typedData))
  if (decoded === undefined || canonicalJson(decoded.domain) !== canonicalJson(delegationDomain(choice.chain)))
    throw new Error('allowance_mismatch: the draft is not a delegation on this chain')
  const nowS = Math.floor(nowMs / 1000)
  const preparedAt = draftStart(choice.chain, decoded.message.caveats) + START_LEAD_S
  if (Math.abs(nowS - preparedAt) > REVIEW_WINDOW_S)
    throw new Error('allowance_mismatch: the draft is stale or from the future; prepare it again')
  const spec = choiceSpec(choice, preparedAt, BigInt(decoded.message.salt))
  const rebuilt = buildAllowance(spec)
  const hash = delegationHash(rebuilt)
  // The struct hash covers every signed field; the owner signs the rebuilt typed data, never the server's.
  if (hash !== draft.delegationHash.toLowerCase())
    throw new Error('allowance_mismatch: the delegation differs from the allowance you chose')
  return {
    delegationHash: hash,
    typedData: delegationTypedData(choice.chain, rebuilt),
    description: {
      chainId: choice.chain.id,
      token: choice.chain.usdc.symbol,
      perHour: formatUnits(spec.amount, choice.chain.usdc.decimals),
      periodSeconds: ALLOWANCE_PERIOD_S,
      startsAt: new Date(preparedAt * 1000).toISOString(),
      expiresAt: new Date(allowanceExpiry(spec) * 1000).toISOString(),
      agent: choice.agent,
    },
  }
}
