// The wallet overview as data, shared by the dashboard App and the owner's Home: what the agent can spend on which
// network and what limits it, what needs the owner, and the balances grouped by network. Pure: the status in, plain
// values out, money as integer micro-dollars. Unknown is its own value and is never shown as zero.
import type {
  ChainBalance,
  ChainKey,
  ChainSetup,
  LimitView,
  Operation,
  WalletStatusResult,
} from '@goblin/wallet/contract'
import { isStable, microsOf, minMicros, unitsOf } from './money.ts'

/** An amount the wallet read, or one it could not. */
export type Figure = { readonly known: true; readonly micros: bigint } | { readonly known: false }

const known = (micros: bigint): Figure => ({ known: true, micros })
const UNKNOWN: Figure = { known: false }

/** The order networks are listed in: Base first, where the paid services settle. */
export const NETWORK_ORDER: readonly ChainKey[] = ['base', 'arbitrum', 'ethereum', 'tempo']
const PRIMARY: ChainKey = 'base'
const EVM: ReadonlySet<ChainKey> = new Set(['base', 'arbitrum', 'ethereum'])
const NO_ADDRESS = '0x0000000000000000000000000000000000000000'

export const hasAgent = (status: WalletStatusResult): boolean => status.agent.address !== NO_ADDRESS

// --- Balances, grouped by network -------------------------------------------------------------------------------

export interface Holding {
  readonly amount: string
  readonly positive: boolean
}

export interface AssetRow {
  readonly symbol: string
  /** Stablecoins pay for services; ETH pays gas and is never added to a dollar figure. */
  readonly role: 'payments' | 'gas'
  readonly agent: Holding | undefined
  readonly owner: Holding | undefined
}

export interface NetworkBalances {
  readonly chain: ChainKey
  /** False when the network could not be read: its balances are unknown, not zero. */
  readonly read: boolean
  readonly agentAddress: string | undefined
  readonly ownerAddress: string | undefined
  readonly assets: readonly AssetRow[]
  /** Read, and something on it is above zero. */
  readonly funded: boolean
}

const holdingOf = (row: ChainBalance | undefined): Holding | undefined =>
  row === undefined ? undefined : { amount: row.balance, positive: unitsOf(row.balance, row.decimals) > 0n }

/**
 * Whether a network was read. The status carries no per-network read result yet, so it is inferred from what a read
 * always returns: every EVM account read includes its ETH, and the owner appears on every network or on none. A
 * network that failed comes back with only the agent's zero stablecoin, which must not read as a verified zero.
 */
function networkRead(chain: ChainKey, rows: readonly ChainBalance[], ownerSeen: boolean): boolean {
  if (rows.length === 0) return false
  if (EVM.has(chain) && !rows.some((row) => row.holder === 'agent' && row.symbol === 'ETH')) return false
  return !ownerSeen || rows.some((row) => row.holder === 'owner')
}

function assetsOf(rows: readonly ChainBalance[]): AssetRow[] {
  const symbols = [...new Set(rows.map((row) => row.symbol))].toSorted(
    (a, b) => Number(isStable(b)) - Number(isStable(a)),
  )
  return symbols.map((symbol) => {
    const of = (holder: ChainBalance['holder']) => rows.find((row) => row.holder === holder && row.symbol === symbol)
    return {
      symbol,
      role: isStable(symbol) ? 'payments' : 'gas',
      agent: holdingOf(of('agent')),
      owner: holdingOf(of('owner')),
    }
  })
}

function groupOf(chain: ChainKey, rows: readonly ChainBalance[], ownerSeen: boolean): NetworkBalances {
  const read = networkRead(chain, rows, ownerSeen)
  const assets = read ? assetsOf(rows) : []
  return {
    chain,
    read,
    agentAddress: rows.find((row) => row.holder === 'agent')?.address,
    ownerAddress: rows.find((row) => row.holder === 'owner')?.address,
    assets,
    funded: assets.some((asset) => asset.agent?.positive === true || asset.owner?.positive === true),
  }
}

/** Every network the wallet reads, Base first. Without an agent there is nothing to read yet. */
export function balanceGroups(status: WalletStatusResult): readonly NetworkBalances[] {
  if (!hasAgent(status)) return []
  const ownerSeen = status.balances.some((row) => row.holder === 'owner')
  return NETWORK_ORDER.map((chain) =>
    groupOf(
      chain,
      status.balances.filter((row) => row.chain === chain),
      ownerSeen,
    ),
  )
}

// --- What the agent can spend -------------------------------------------------------------------------------------

export type Allowance =
  | { readonly kind: 'none' }
  /** The owner has an allowance on this network but its enforcer could not be read. */
  | { readonly kind: 'unknown' }
  | { readonly kind: 'active'; readonly remaining: bigint; readonly limit: LimitView }

export interface NetworkSpend {
  readonly chain: ChainKey
  /** The stablecoin the agent pays with on this network. */
  readonly symbol: string
  readonly agent: Figure
  readonly owner: Figure
  readonly allowance: Allowance
  /** The agent's own stablecoin plus what the on-chain allowance lets it draw from the owner's. */
  readonly reachable: Figure
}

/** What sets the amount available now. */
export type Constraint =
  | { readonly kind: 'funds' }
  /** The allowance lets the agent draw less than the owner holds. */
  | { readonly kind: 'allowance'; readonly limit: LimitView }
  | { readonly kind: 'limit'; readonly limit: LimitView }

export type Blocker =
  | { readonly kind: 'no_agent' }
  | { readonly kind: 'access_ended'; readonly at: string | undefined }
  | { readonly kind: 'unread' }
  | { readonly kind: 'no_allowance'; readonly owner: bigint }
  | { readonly kind: 'allowance_used'; readonly owner: bigint; readonly limit: LimitView }
  | { readonly kind: 'limit_reached'; readonly limit: LimitView }
  /** The owner holds stablecoins on a network the agent cannot draw from. */
  | { readonly kind: 'elsewhere'; readonly chain: ChainKey; readonly symbol: string; readonly owner: bigint }
  | { readonly kind: 'gas_only' }
  | { readonly kind: 'no_funds' }

export type NextAction = 'finish_setup' | 'renew_access' | 'refresh' | 'set_allowance' | 'wait' | 'add_funds'

const NEXT: Record<Blocker['kind'], NextAction> = {
  no_agent: 'finish_setup',
  access_ended: 'renew_access',
  unread: 'refresh',
  no_allowance: 'set_allowance',
  allowance_used: 'wait',
  limit_reached: 'wait',
  elsewhere: 'add_funds',
  gas_only: 'add_funds',
  no_funds: 'add_funds',
}

export const nextActionOf = (blocker: Blocker): NextAction => NEXT[blocker.kind]

export interface NetworkAvailable {
  readonly spend: NetworkSpend
  readonly available: Figure
  readonly constraint: Constraint | undefined
}

export interface Spending extends NetworkAvailable {
  readonly blocker: Blocker | undefined
  /** The smallest per-payment cap that applies on this network. */
  readonly perPayment: LimitView | undefined
  /** Other networks where the agent can spend something now. */
  readonly others: readonly NetworkAvailable[]
}

const stableOf = (rows: readonly ChainBalance[], holder: ChainBalance['holder']): ChainBalance | undefined =>
  rows.find((row) => row.holder === holder && isStable(row.symbol))

const appliesTo = (limit: LimitView, chain: ChainKey): boolean => limit.chain === undefined || limit.chain === chain

function allowanceOn(
  chain: ChainKey,
  limits: readonly LimitView[],
  setups: readonly ChainSetup[] | undefined,
): Allowance {
  const limit = limits.find((entry) => entry.layer === 'onchain' && entry.chain === chain)
  if (limit !== undefined) return { kind: 'active', remaining: microsOf(limit.remaining ?? '0'), limit }
  const recorded = setups?.find((setup) => setup.chain === chain)?.allowance
  return recorded === undefined ? { kind: 'none' } : { kind: 'unknown' }
}

function reachableOf(agent: Figure, owner: Figure, allowance: Allowance): Figure {
  if (!agent.known) return UNKNOWN
  if (allowance.kind === 'none') return agent
  if (allowance.kind === 'unknown' || !owner.known) return UNKNOWN
  const draw = owner.micros < allowance.remaining ? owner.micros : allowance.remaining
  return known(agent.micros + draw)
}

function spendOn(
  group: NetworkBalances,
  rows: readonly ChainBalance[],
  limits: readonly LimitView[],
  setups: readonly ChainSetup[] | undefined,
): NetworkSpend {
  const figure = (holder: ChainBalance['holder']): Figure => {
    if (!group.read) return UNKNOWN
    const row = stableOf(rows, holder)
    return known(row === undefined ? 0n : microsOf(row.balance))
  }
  const agent = figure('agent')
  const owner = figure('owner')
  const allowance = allowanceOn(group.chain, limits, setups)
  const symbol = rows.find((row) => isStable(row.symbol))?.symbol ?? 'USDC'
  return { chain: group.chain, symbol, agent, owner, allowance, reachable: reachableOf(agent, owner, allowance) }
}

/** The spending limits that hold back a payment on `chain` now: every metered one that applies, but the allowance. */
const capsOn = (limits: readonly LimitView[], chain: ChainKey): readonly LimitView[] =>
  limits.filter(
    (limit) =>
      limit.layer !== 'onchain' && limit.period !== 'call' && limit.remaining !== undefined && appliesTo(limit, chain),
  )

function fundsConstraint(spend: NetworkSpend): Constraint {
  const { allowance, owner } = spend
  if (allowance.kind === 'active' && owner.known && allowance.remaining < owner.micros)
    return { kind: 'allowance', limit: allowance.limit }
  return { kind: 'funds' }
}

/** What is available now on one network: what the agent can reach, held back by every limit that applies there. */
export function availableOn(spend: NetworkSpend, limits: readonly LimitView[]): NetworkAvailable {
  if (!spend.reachable.known) return { spend, available: UNKNOWN, constraint: undefined }
  let micros = spend.reachable.micros
  let constraint = fundsConstraint(spend)
  for (const limit of capsOn(limits, spend.chain)) {
    const remaining = microsOf(limit.remaining ?? '0')
    if (remaining < micros) {
      micros = remaining
      constraint = { kind: 'limit', limit }
    }
  }
  return { spend, available: known(micros), constraint }
}

/** The smallest per-payment cap on `chain`, from any layer. */
export function perPaymentOn(limits: readonly LimitView[], chain: ChainKey): LimitView | undefined {
  const caps = limits.filter((limit) => limit.period === 'call' && appliesTo(limit, chain))
  const smallest = minMicros(caps.map((limit) => microsOf(limit.limit)))
  return caps.find((limit) => microsOf(limit.limit) === smallest)
}

// --- Why nothing is available, and what to do -------------------------------------------------------------------

interface BlockerInput {
  readonly status: WalletStatusResult
  readonly primary: NetworkAvailable
  readonly spends: readonly NetworkSpend[]
  readonly groups: readonly NetworkBalances[]
  readonly now: number
}

const positive = (figure: Figure): boolean => figure.known && figure.micros > 0n

/** The grant expired, or the wallet refuses payments although money is there to spend (the owner revoked access). */
function accessEnded({ status, primary, now }: BlockerInput): Blocker | undefined {
  const at = status.status.expiresAt
  const expired = at !== undefined && Date.parse(at) <= now
  const refused = status.status.paid === 'blocked' && positive(primary.available)
  return expired || refused ? { kind: 'access_ended', at } : undefined
}

/** Nothing reachable: the owner's money is there without an allowance, used up, on another network, or absent. */
function emptyReason({ primary, spends, groups }: BlockerInput): Blocker {
  const { spend } = primary
  if (spend.owner.known && spend.owner.micros > 0n) {
    if (spend.allowance.kind === 'active')
      return { kind: 'allowance_used', owner: spend.owner.micros, limit: spend.allowance.limit }
    if (spend.allowance.kind === 'none') return { kind: 'no_allowance', owner: spend.owner.micros }
  }
  for (const other of spends)
    if (other.chain !== spend.chain && other.owner.known && other.owner.micros > 0n)
      return { kind: 'elsewhere', chain: other.chain, symbol: other.symbol, owner: other.owner.micros }
  const gas = groups
    .find((group) => group.chain === spend.chain)
    ?.assets.some((asset) => asset.role === 'gas' && (asset.agent?.positive === true || asset.owner?.positive === true))
  return gas === true ? { kind: 'gas_only' } : { kind: 'no_funds' }
}

/** Why the agent cannot spend on its network now, or undefined when it can. */
export function blockerOf(input: BlockerInput): Blocker | undefined {
  if (!hasAgent(input.status)) return { kind: 'no_agent' }
  const ended = accessEnded(input)
  if (ended !== undefined) return ended
  const { available, spend, constraint } = input.primary
  if (!available.known) return { kind: 'unread' }
  if (available.micros > 0n) return undefined
  if (positive(spend.reachable) && constraint?.kind === 'limit')
    return { kind: 'limit_reached', limit: constraint.limit }
  return emptyReason(input)
}

// --- The summary ------------------------------------------------------------------------------------------------

const NOTHING: NetworkSpend = {
  chain: PRIMARY,
  symbol: 'USDC',
  agent: UNKNOWN,
  owner: UNKNOWN,
  allowance: { kind: 'none' },
  reachable: UNKNOWN,
}

/**
 * The network the summary leads with: Base, unless the agent has nothing there and can spend elsewhere. A Base that
 * could not be read stays first, so an unknown is said rather than skipped.
 */
function primaryOf(options: readonly NetworkAvailable[]): NetworkAvailable {
  const base = options.find((option) => option.spend.chain === PRIMARY)
  if (base !== undefined && (!base.available.known || base.available.micros > 0n)) return base
  return (
    options.find((option) => positive(option.available)) ??
    base ?? { spend: NOTHING, available: UNKNOWN, constraint: undefined }
  )
}

export interface SpendingOptions {
  readonly now?: number
  /** The owner's per-network setup (Home has it): tells an allowance that could not be read from none at all. */
  readonly setups?: readonly ChainSetup[]
}

/** What the agent can spend now, on which network, what limits it, and what to do when it cannot. */
export function spendingOf(status: WalletStatusResult, options: SpendingOptions = {}): Spending {
  const groups = balanceGroups(status)
  const spends = groups.map((group) =>
    spendOn(
      group,
      status.balances.filter((row) => row.chain === group.chain),
      status.limits,
      options.setups,
    ),
  )
  const all = spends.map((spend) => availableOn(spend, status.limits))
  const primary = primaryOf(all)
  return {
    ...primary,
    blocker: blockerOf({ status, primary, spends, groups, now: options.now ?? Date.now() }),
    perPayment: perPaymentOn(status.limits, primary.spend.chain),
    others: all.filter((option) => option !== primary && positive(option.available)),
  }
}

// --- Attention and boundaries -------------------------------------------------------------------------------------

export interface Attention {
  /** `approval`: the agent waits for the owner. `uncertain`: a payment whose outcome is not known yet. */
  readonly kind: 'approval' | 'uncertain'
  readonly operation: Operation
}

/** What needs the owner: approvals first, then payments whose outcome is unknown. */
export function attentionOf(operations: readonly Operation[]): readonly Attention[] {
  const of = (kind: Attention['kind'], status: Operation['status']): Attention[] =>
    operations.filter((operation) => operation.status === status).map((operation) => ({ kind, operation }))
  return [...of('approval', 'awaiting_approval'), ...of('uncertain', 'uncertain')]
}

const LAYER_ORDER = ['onchain', 'tempo', 'signer', 'ledger', 'client'] as const
const PERIOD_ORDER = ['call', 'hour', 'day', 'week', 'total'] as const

/** Per payment first, then the shorter periods; within a period, the chain's limit before this service's word. */
export const limitOrder = (a: LimitView, b: LimitView): number =>
  PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period) ||
  LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer)

export interface Boundary {
  readonly limit: LimitView
  /** The limit that sets what is available now. */
  readonly binding: boolean
}

/**
 * The limits that apply on the summary's network, in order. The grant's end is said once, as when access ends, so
 * the ledger's open-ended `total` without a remaining amount is left out.
 */
export function boundariesOf(spending: Spending, limits: readonly LimitView[]): readonly Boundary[] {
  const { constraint } = spending
  const binding = constraint === undefined || constraint.kind === 'funds' ? undefined : constraint.limit
  return limits
    .filter(
      (limit) => appliesTo(limit, spending.spend.chain) && (limit.period !== 'total' || limit.remaining !== undefined),
    )
    .toSorted(limitOrder)
    .map((limit) => ({ limit, binding: limit === binding }))
}
