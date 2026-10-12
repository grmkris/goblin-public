import type { ApprovalView, Connection, Me, WalletLimits } from '@goblin/wallet/contract'
import {
  ADDRESS_BOOK,
  APPROVAL,
  CONNECTIONS,
  LIMITS,
  ME,
  OAUTH_REQUEST,
  OPERATIONS,
  SERVICES,
  STATUS,
} from './fixtures.ts'
import type { WalletApi } from './types.ts'

const delay = async <T>(value: T): Promise<T> => {
  await new Promise((resolve) => setTimeout(resolve, 120))
  return value
}

/** In-memory API: edits stick for the session so the pages can be clicked through. */
export function createFixtureApi(): WalletApi {
  let me: Me = ME
  let connections: readonly Connection[] = CONNECTIONS
  let approval: ApprovalView = APPROVAL
  return {
    me: () => delay(me),
    status: () => delay(STATUS),
    limits: () => delay(LIMITS),
    setLimits: (limits: WalletLimits) => {
      me = { ...me, limits }
      return delay(limits)
    },
    activity: () => delay(OPERATIONS),
    approval: () => delay(approval),
    decide: (_id, decision) => {
      approval = { ...approval, status: decision.decision === 'approve' ? 'approved' : 'declined' }
      return delay(approval)
    },
    services: () => delay(SERVICES),
    addressBook: () => delay(ADDRESS_BOOK),
    connections: () => delay(connections),
    disconnect: (id) => {
      connections = connections.filter((connection) => connection.id !== id)
      return delay(connections)
    },
    oauthRequest: () => delay(OAUTH_REQUEST),
    oauthDecide: () => delay({ redirectTo: '/' }),
    revokeAll: () => {
      connections = []
      me = { ...me, chains: me.chains.map(({ chain, upgraded }) => ({ chain, upgraded })) }
      return delay(me)
    },
  }
}
