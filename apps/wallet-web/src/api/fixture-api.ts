import type { EvmChain } from '@goblin/wallet/balances'
import {
  type ApprovalView,
  type ChainSetup,
  type Connection,
  DEFAULT_GRANT_DAYS,
  type Me,
  type PolicyChange,
  termsHash,
} from '@goblin/wallet/contract'
import {
  ADDRESS_BOOK,
  AGENT,
  APPROVAL,
  CONNECTIONS,
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

interface World {
  me: Me
  connections: readonly Connection[]
  approval: ApprovalView
  policyChanges: readonly PolicyChange[]
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
    status: () => delay(STATUS),
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

/** In-memory API: edits stick for the session so the pages can be clicked through. */
export function createFixtureApi(start: 'fresh' | 'ready' = 'ready'): FixtureApi {
  const world: World = {
    me: start === 'ready' ? ME : { userId: ME.userId, owner: OWNER, chains: [] },
    connections: start === 'ready' ? CONNECTIONS : [],
    approval: APPROVAL,
    policyChanges: start === 'ready' ? POLICY_CHANGES : [],
  }
  return { ...reads(world), ...writes(world), simulate: simulate(world) }
}
