import { formatUnits, parseUnits } from '@goblin/wallet/amounts'
import type { EvmChain } from '@goblin/wallet/balances'
import {
  type ApprovalView,
  type ChainSetup,
  type Connection,
  DEFAULT_GRANT_DAYS,
  type DepositAddress,
  type DepositRequest,
  type DepositStatus,
  type LimitView,
  type Me,
  type PolicyChange,
  termsHash,
  type WalletStatusResult,
} from '@goblin/wallet/contract'
import {
  ADDRESS_BOOK,
  AGENT,
  APPROVAL,
  CONNECTIONS,
  FRESH_STATUS,
  LIMITS,
  ME,
  OAUTH_REQUEST,
  OPERATIONS,
  OWNER,
  POLICY_CHANGES,
  SERVICES,
  STATUS,
} from './fixtures.ts'
import type { WalletApi } from './types.ts'

const delay = async <T>(value: T): Promise<T> => {
  await new Promise((resolve) => setTimeout(resolve, 120))
  return value
}

interface FixtureDeposit {
  readonly quote: DepositAddress
  polls: number
  credited: boolean
}

interface World {
  me: Me
  status: WalletStatusResult
  connections: readonly Connection[]
  approval: ApprovalView
  policyChanges: readonly PolicyChange[]
  readonly deposits: Map<string, FixtureDeposit>
}

export interface FixtureApi extends WalletApi {
  /** What the fixture signer does when the owner signs: the same state change the server would make. */
  readonly simulate: {
    readonly upgrade: (chain: EvmChain) => void
    readonly allowance: (input: { readonly chain: EvmChain; readonly perHour: string }) => void
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
  | 'policyChanges'
> {
  return {
    me: () => delay(world.me),
    status: () => delay(world.status),
    limits: () => delay(LIMITS),
    activity: () => delay(OPERATIONS),
    approval: async () => delay({ ...world.approval, termsHash: await termsHash(world.approval.terms) }),
    services: () => delay(SERVICES),
    addressBook: () => delay(ADDRESS_BOOK),
    connections: () => delay(world.connections),
    oauthRequest: () => delay(OAUTH_REQUEST),
    policyChanges: () => delay(world.policyChanges),
  }
}

function writes(
  world: World,
): Pick<
  WalletApi,
  'createAgent' | 'setLimits' | 'decide' | 'disconnect' | 'oauthDecide' | 'revokeAll' | 'decidePolicyChange'
> {
  return {
    createAgent: () => {
      world.me = { ...world.me, agent: AGENT }
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
    disconnect: (id) => {
      world.connections = world.connections.filter((connection) => connection.id !== id)
      return delay(world.connections)
    },
    oauthDecide: () => delay({ redirectTo: '/' }),
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

/** In-memory API: edits stick for the session so the pages can be clicked through. */
export function createFixtureApi(start: 'fresh' | 'ready' = 'ready'): FixtureApi {
  const world: World = {
    me: start === 'ready' ? ME : { userId: ME.userId, owner: OWNER, chains: [] },
    status: start === 'ready' ? STATUS : FRESH_STATUS,
    connections: start === 'ready' ? CONNECTIONS : [],
    approval: APPROVAL,
    policyChanges: start === 'ready' ? POLICY_CHANGES : [],
    deposits: new Map(),
  }
  return { ...reads(world), ...writes(world), ...deposits(world), simulate: simulate(world) }
}
