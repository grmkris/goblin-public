import type {
  ApprovalDecision,
  ApprovalView,
  Connection,
  DepositAddress,
  DepositRequest,
  DepositStatus,
  LimitView,
  Me,
  Operation,
  PolicyChange,
  Recipient,
  ServiceRule,
  WalletLimits,
  WalletStatusResult,
} from '@goblin/wallet/contract'

export interface OAuthRequestView {
  readonly id: string
  readonly client: string
  readonly redirectHost: string
  readonly scopes: readonly string[]
  readonly expiresAt: string
}

/** What the pages need from the server. `httpApi` calls OwnerRoutes; `fixtureApi` answers from fixtures. */
export interface WalletApi {
  readonly me: () => Promise<Me>
  /** Balances per chain and holder; absent routes answer `undefined` and Home says so. */
  readonly status: () => Promise<WalletStatusResult | undefined>
  /** Create the owner's agent wallet; idempotent. */
  readonly createAgent: () => Promise<Me>
  readonly limits: () => Promise<readonly LimitView[]>
  readonly setLimits: (limits: WalletLimits) => Promise<WalletLimits>
  readonly activity: () => Promise<readonly Operation[]>
  readonly approval: (operationId: string) => Promise<ApprovalView>
  readonly decide: (operationId: string, decision: ApprovalDecision) => Promise<ApprovalView>
  readonly services: () => Promise<readonly ServiceRule[]>
  readonly addressBook: () => Promise<readonly Recipient[]>
  readonly connections: () => Promise<readonly Connection[]>
  readonly disconnect: (id: string) => Promise<readonly Connection[]>
  readonly oauthRequest: (id: string) => Promise<OAuthRequestView>
  readonly oauthDecide: (id: string, decision: 'approve' | 'deny') => Promise<{ readonly redirectTo: string }>
  readonly policyChanges: () => Promise<readonly PolicyChange[]>
  readonly decidePolicyChange: (id: string, decision: 'applied' | 'dismissed') => Promise<PolicyChange>
  readonly revokeAll: () => Promise<Me>
  /** A one-off Relay deposit address: what is sent there from another chain lands in the owner's account on Base. */
  readonly deposit: (request: DepositRequest) => Promise<DepositAddress>
  /** Relay's progress for one deposit address; `unknown` when Relay's status API does not answer. */
  readonly depositStatus: (depositAddress: string) => Promise<DepositStatus>
}
