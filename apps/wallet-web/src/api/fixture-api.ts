import { formatUnits, parseUnits } from '@goblin/wallet/amounts'
import type { EvmChain } from '@goblin/wallet/balances'
import {
  type ApprovalView,
  type ChainSetup,
  type Connection,
  DEFAULT_GRANT_DAYS,
  DEFAULT_LIMITS,
  type DepositAddress,
  type DepositRequest,
  type DepositStatus,
  type LimitView,
  type Me,
  type Operation,
  type PolicyChange,
  type SubscriptionView,
  termsHash,
  type WalletStatusResult,
} from '@goblin/wallet/contract'
import {
  ADDRESS_BOOK,
  AGENT,
  APPROVAL,
  CLIENT_ORIGINS,
  CONNECTIONS,
  FRESH_STATUS,
  LIMITS,
  ME,
  NO_AGENT_STATUS,
  OAUTH_REQUEST,
  OPERATIONS,
  OWNER,
  POLICY_CHANGES,
  SERVICES,
  STATUS,
} from './fixtures.ts'
import { fixtureSubscriptions, signedNow } from './subscription-fixtures.ts'
import type { WalletApi } from './types.ts'

const delay = async <T>(value: T): Promise<T> => {
  await new Promise((resolve) => setTimeout(resolve, 120))
  return value
}

/** The ledger's defaults on a wallet created now: $5 a payment, $20 an hour, $50 a week, for seven days. */
const FRESH_LIMITS = {
  ...DEFAULT_LIMITS,
  expiresAt: new Date(Date.now() + DEFAULT_GRANT_DAYS * 86_400_000).toISOString(),
  version: 1,
}

interface FixtureDeposit {
  readonly quote: DepositAddress
  polls: number
  credited: boolean
}

/**
 * Where the demo starts. `ready`: set up and busy. `fresh`: just signed in, no agent wallet, goblin asking to connect;
 * a few balance reads after the agent wallet exists, $12 of USDC lands on Base, as a send would. `funded`: the agent
 * wallet exists and USDC is on Base, but spending is not turned on. `expired`: set up, and goblin's request ran out.
 */
export type FixtureStart = 'ready' | 'fresh' | 'funded' | 'expired'

export const FIXTURE_STARTS: readonly FixtureStart[] = ['ready', 'fresh', 'funded', 'expired']

interface World {
  readonly start: FixtureStart
  me: Me
  status: WalletStatusResult
  connections: readonly Connection[]
  approval: ApprovalView
  policyChanges: readonly PolicyChange[]
  /** A fresh owner has no history and only the wallet's default limits. */
  readonly activity: readonly Operation[]
  readonly limits: readonly LimitView[]
  readonly deposits: Map<string, FixtureDeposit>
  /** goblin Pro: a request to sign, and in a busy wallet a subscription already running. */
  subscriptions: readonly SubscriptionView[]
  /** Balance reads since the agent wallet was created, in `fresh`: the third one sees the send land. */
  reads: number
}

export interface FixtureApi extends WalletApi {
  /** What the fixture signer does when the owner signs: the same state change the server would make. */
  readonly simulate: {
    readonly upgrade: (chain: EvmChain) => void
    readonly allowance: (input: { readonly chain: EvmChain; readonly perHour: string }) => void
    /** The owner signed subscription `id` (and its first period was paid), or cancelled it. */
    readonly subscription: (id: string, change: 'signed' | 'cancelled') => SubscriptionView | undefined
  }
}

/** One chain's setup changed, the others kept: the chain is added when the owner had not set it up before. */
const withSetup = (chains: Me['chains'], chain: EvmChain, patch: Partial<ChainSetup>): Me['chains'] => {
  const existing = chains.find((entry) => entry.chain === chain)
  const next: ChainSetup = { ...(existing ?? { chain, upgraded: false }), ...patch }
  return existing === undefined ? [...chains, next] : chains.map((entry) => (entry.chain === chain ? next : entry))
}

function simulate(world: World): FixtureApi['simulate'] {
  return {
    subscription: (id, change) => {
      world.subscriptions = world.subscriptions.map((view) =>
        view.id !== id ? view : change === 'signed' ? signedNow(view) : { ...view, status: 'revoked' },
      )
      return world.subscriptions.find((view) => view.id === id)
    },
    upgrade: (chain) => {
      world.me = { ...world.me, chains: withSetup(world.me.chains, chain, { upgraded: true }) }
    },
    allowance: ({ chain, perHour }) => {
      const allowance = {
        perHour,
        expiresAt: new Date(Date.now() + DEFAULT_GRANT_DAYS * 86_400_000).toISOString(),
        delegationHash: `0x${'9a'.repeat(32)}`,
      }
      const limits = world.me.limits ?? ME.limits
      world.me = {
        ...world.me,
        chains: withSetup(world.me.chains, chain, { upgraded: true, allowance }),
        ...(limits === undefined ? {} : { limits }),
      }
      // The chain's enforcer now reports the allowance, untouched for this hour.
      const onchain: LimitView = {
        layer: 'onchain',
        period: 'hour',
        limit: perHour,
        used: '0',
        remaining: perHour,
        chain,
        enforcedBy: 'MetaMask ERC20PeriodTransfer enforcer',
        periodEndsAt: new Date(Date.now() + 3_600_000).toISOString(),
      }
      const others = world.status.limits.filter((limit) => !(limit.layer === 'onchain' && limit.chain === chain))
      // With an allowance on Base the server reports payments ready, as it would.
      world.status = {
        ...world.status,
        status: { ...world.status.status, paid: 'ready', funding: 'ready' },
        limits: [...others, onchain],
      }
    },
  }
}

/** The owner's USDC on Base set to `amount`, as a send to their address would leave it. */
const ownerUsdcOnBase = (status: WalletStatusResult, amount: string): WalletStatusResult => ({
  ...status,
  balances: status.balances.map((row) =>
    row.chain === 'base' && row.holder === 'owner' && row.symbol === 'USDC' ? { ...row, balance: amount } : row,
  ),
})

/** One balance read; in `fresh`, the third one after the agent wallet exists sees the owner's send land. */
function readStatus(world: World): WalletStatusResult {
  if (world.start === 'fresh' && world.me.agent !== undefined && ++world.reads === 3)
    world.status = ownerUsdcOnBase(world.status, '12')
  return world.status
}

/** goblin's request as the consent page reads it: open, or run out in `expired`. */
const oauthView = (world: World, minutes: number) =>
  world.start === 'expired'
    ? { ...OAUTH_REQUEST, expiresAt: new Date(Date.now() - 60_000).toISOString(), expired: true as const }
    : { ...OAUTH_REQUEST, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString() }

/** Setup may send the owner back to a URL on one of their clients' origins, and nowhere else. */
function returnTarget(url: string): { readonly url?: string; readonly host?: string } {
  if (!URL.canParse(url)) return {}
  const parsed = new URL(url)
  return CLIENT_ORIGINS.includes(parsed.origin) ? { url: parsed.href, host: parsed.host } : {}
}

function reads(
  world: World,
): Pick<
  WalletApi,
  | 'me'
  | 'status'
  | 'limits'
  | 'activity'
  | 'approval'
  | 'services'
  | 'addressBook'
  | 'connections'
  | 'oauthRequest'
  | 'oauthKeepAlive'
  | 'returnCheck'
  | 'policyChanges'
> {
  return {
    me: () => delay(world.me),
    status: () => delay(readStatus(world)),
    limits: () => delay(world.limits),
    activity: () => delay(world.activity),
    approval: async () => delay({ ...world.approval, termsHash: await termsHash(world.approval.terms) }),
    services: () => delay(SERVICES),
    addressBook: () => delay(ADDRESS_BOOK),
    connections: () => delay(world.connections),
    oauthRequest: () => delay(oauthView(world, 8)),
    oauthKeepAlive: () => delay(oauthView(world, 10)),
    returnCheck: (url) => delay(returnTarget(url)),
    policyChanges: () => delay(world.policyChanges),
  }
}

function writes(
  world: World,
): Pick<
  WalletApi,
  | 'createAgent'
  | 'setLimits'
  | 'decide'
  | 'checkOperation'
  | 'disconnect'
  | 'oauthDecide'
  | 'revokeAll'
  | 'decidePolicyChange'
> {
  return {
    createAgent: () => {
      // The server creates it with the default limits for seven days, and the agent's balances start being read.
      world.me = { ...world.me, agent: AGENT, limits: world.me.limits ?? FRESH_LIMITS }
      if (world.status.agent.address !== AGENT) world.status = FRESH_STATUS
      return delay(world.me)
    },
    setLimits: (limits) => {
      world.me = { ...world.me, limits }
      return delay(limits)
    },
    decide: (_id, decision) => {
      world.approval = { ...world.approval, status: decision.decision === 'approve' ? 'approved' : 'declined' }
      return delay(world.approval)
    },
    // The demo chain has not seen the transaction yet: the check reads, finds nothing and changes nothing.
    checkOperation: (operationId) => {
      const operation = OPERATIONS.find((each) => each.id === operationId) ?? OPERATIONS[0]!
      return delay({
        operation,
        found: 'unknown' as const,
        note:
          operation.payment?.authorization === undefined
            ? 'The transaction is not on chain yet. Check again in a few minutes.'
            : 'The authorization is unused but could still settle for another 4 min. Check again after that.',
      })
    },
    disconnect: (id) => {
      world.connections = world.connections.filter((connection) => connection.id !== id)
      return delay(world.connections)
    },
    // Back to the demo itself: a real client's redirect would leave the fixtures.
    oauthDecide: () => delay({ redirectTo: `/?fixtures=${world.start}` }),
    decidePolicyChange: (id, decision) => {
      world.policyChanges = world.policyChanges.map((change) =>
        change.id === id ? { ...change, status: decision } : change,
      )
      return delay(world.policyChanges.find((change) => change.id === id) ?? POLICY_CHANGES[0]!)
    },
    revokeAll: () => {
      world.connections = []
      world.me = { ...world.me, chains: world.me.chains.map(({ chain, upgraded }) => ({ chain, upgraded })) }
      return delay(world.me)
    },
  }
}

/** What a fixture deposit receives: ETH at $2,500, less a flat four-cent fee, worked in base units. */
function fixtureOut({ asset, amount, receive }: DepositRequest): string {
  const FEE_USDC = 40_000n
  if (asset === receive) {
    const decimals = asset === 'ETH' ? 18 : 6
    const fee = asset === 'ETH' ? 16_000_000_000_000n : FEE_USDC
    const units = parseUnits(amount, decimals)
    return formatUnits(units > fee ? units - fee : 0n, decimals)
  }
  if (asset === 'ETH') {
    const usdc = (parseUnits(amount, 18) * 2500n) / 10n ** 12n
    return formatUnits(usdc > FEE_USDC ? usdc - FEE_USDC : 0n, 6)
  }
  const usdc = parseUnits(amount, 6)
  return formatUnits(usdc > FEE_USDC ? ((usdc - FEE_USDC) * 10n ** 12n) / 2500n : 0n, 18)
}

/** Relay's answers for a fixture deposit, one per poll: waiting, not reporting, seen, then landed on Base. */
const PROGRESS: readonly DepositStatus['status'][] = ['waiting', 'unknown', 'pending', 'success']

/** A landed deposit raises the owner's balance on Base, as the chain would. */
function credit(world: World, quote: DepositAddress): void {
  world.status = {
    ...world.status,
    balances: world.status.balances.map((row) =>
      row.chain === 'base' && row.holder === 'owner' && row.symbol === quote.receive
        ? {
            ...row,
            balance: formatUnits(
              parseUnits(row.balance, row.decimals) + parseUnits(quote.expectedOut, row.decimals),
              row.decimals,
            ),
          }
        : row,
    ),
  }
}

function deposits(world: World): Pick<WalletApi, 'deposit' | 'depositStatus'> {
  return {
    deposit: (request) => {
      const index = world.deposits.size + 1
      const depositAddress = `0x${'d3'.repeat(19)}${index.toString(16).padStart(2, '0')}`
      const quote: DepositAddress = {
        requestId: `req_fixture_${index}`,
        depositAddress,
        ...request,
        expectedOut: fixtureOut(request),
        feesUsd: '0.04',
        recipient: OWNER,
        timeEstimateSeconds: request.from === 'ethereum' ? 60 : 20,
      }
      world.deposits.set(depositAddress, { quote, polls: 0, credited: false })
      return delay(quote)
    },
    depositStatus: (depositAddress) => {
      const entry = world.deposits.get(depositAddress)
      if (entry === undefined) return Promise.reject(new Error('No deposit with that address.'))
      entry.polls += 1
      const status = PROGRESS[Math.min(entry.polls, PROGRESS.length) - 1] ?? 'waiting'
      if (status === 'success' && !entry.credited) {
        credit(world, entry.quote)
        entry.credited = true
      }
      return delay({ depositAddress, status, txHashes: status === 'success' ? [`0x${'7e'.repeat(32)}`] : [] })
    },
  }
}

const startingMe = (start: FixtureStart): Me => {
  if (start === 'fresh') return { userId: ME.userId, owner: OWNER, chains: [] }
  if (start === 'funded') return { userId: ME.userId, owner: OWNER, agent: AGENT, chains: [], limits: FRESH_LIMITS }
  return ME
}

const startingStatus = (start: FixtureStart): WalletStatusResult => {
  if (start === 'fresh') return NO_AGENT_STATUS
  if (start === 'funded') return ownerUsdcOnBase(FRESH_STATUS, '12')
  return STATUS
}

/** In-memory API: edits stick for the session so the pages can be clicked through. */
export function createFixtureApi(start: FixtureStart = 'ready'): FixtureApi {
  const busy = start === 'ready' || start === 'expired'
  const world: World = {
    start,
    me: startingMe(start),
    status: startingStatus(start),
    connections: busy ? CONNECTIONS : [],
    approval: APPROVAL,
    policyChanges: busy ? POLICY_CHANGES : [],
    activity: busy ? OPERATIONS : [],
    limits: busy ? LIMITS : FRESH_STATUS.limits,
    deposits: new Map(),
    subscriptions: fixtureSubscriptions(busy),
    reads: 0,
  }
  const subscriptions: Pick<WalletApi, 'subscription' | 'subscriptions'> = {
    subscription: (id) => {
      const found = world.subscriptions.find((view) => view.id === id)
      return found === undefined ? Promise.reject(new Error('This subscription is not known.')) : delay(found)
    },
    subscriptions: () => delay(world.subscriptions.filter((view) => view.status !== 'pending')),
  }
  return { ...reads(world), ...writes(world), ...deposits(world), ...subscriptions, simulate: simulate(world) }
}
