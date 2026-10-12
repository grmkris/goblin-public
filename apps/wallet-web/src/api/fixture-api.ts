import { type ApprovalView, type Connection, type Me, termsHash } from '@goblin/wallet/contract'
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
}

export interface FixtureApi extends WalletApi {
  /** What the fixture signer does when the owner signs: the same state change the server would make. */
  readonly simulate: { readonly upgrade: () => void; readonly allowance: () => void }
}

const allowanceState = (): Me['chains'] => [
  {
    chain: 'base',
    upgraded: true,
    allowance: {
      perHour: '20',
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      delegationHash: `0x${'9a'.repeat(32)}`,
    },
  },
]

function simulate(world: World): FixtureApi['simulate'] {
  return {
    upgrade: () => {
      world.me = { ...world.me, chains: [{ chain: 'base', upgraded: true }] }
    },
    allowance: () => {
      world.me = { ...world.me, chains: allowanceState(), ...(ME.limits === undefined ? {} : { limits: ME.limits }) }
    },
  }
}

function reads(
  world: World,
): Pick<
  WalletApi,
  'me' | 'status' | 'limits' | 'activity' | 'approval' | 'services' | 'addressBook' | 'connections' | 'oauthRequest'
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
  }
}

function writes(
  world: World,
): Pick<WalletApi, 'createAgent' | 'setLimits' | 'decide' | 'disconnect' | 'oauthDecide' | 'revokeAll'> {
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
  }
  return { ...reads(world), ...writes(world), simulate: simulate(world) }
}
