import type {
  ApprovalDecision,
  ApprovalView,
  Connection,
  DepositAddress,
  DepositRequest,
  DepositStatus,
  LimitView,
  Me,
  OAuthRequestView as OAuthRequestViewSchema,
  Operation,
  OperationCheck,
  PolicyChange,
  Recipient,
  ReturnCheck,
  ServiceRule,
  SubscriptionView,
  WalletLimits,
  WalletStatusResult,
} from '@goblin/wallet/contract'

/** A consent request as its page shows it; `expired` once it ran out, and the page sends the owner back. */
export type OAuthRequestView = typeof OAuthRequestViewSchema.Type

/** Where `/setup?return=` may send the owner back: set only for the origin of one of their own clients. */
export type ReturnTarget = ReturnCheck

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
  /** Asks the chain how an operation whose outcome is unknown ended; never pays. */
  readonly checkOperation: (operationId: string) => Promise<OperationCheck>
  readonly services: () => Promise<readonly ServiceRule[]>
  readonly addressBook: () => Promise<readonly Recipient[]>
  readonly connections: () => Promise<readonly Connection[]>
  readonly disconnect: (id: string) => Promise<readonly Connection[]>
  readonly oauthRequest: (id: string) => Promise<OAuthRequestView>
  readonly oauthDecide: (id: string, decision: 'approve' | 'deny') => Promise<{ readonly redirectTo: string }>
  /** The consent page is still open: the request stays pending a while longer (at most an hour after it opened). */
  readonly oauthKeepAlive: (id: string) => Promise<OAuthRequestView>
  /** Whether `url` is one of the owner's own clients, so setup may send them back there. */
  readonly returnCheck: (url: string) => Promise<ReturnTarget>
  readonly policyChanges: () => Promise<readonly PolicyChange[]>
  readonly decidePolicyChange: (id: string, decision: 'applied' | 'dismissed') => Promise<PolicyChange>
  readonly revokeAll: () => Promise<Me>
  /** A one-off Relay deposit address: what is sent there from another chain lands in the owner's account on Base. */
  readonly deposit: (request: DepositRequest) => Promise<DepositAddress>
  /** Relay's progress for one deposit address; `unknown` when Relay's status API does not answer. */
  readonly depositStatus: (depositAddress: string) => Promise<DepositStatus>
  /** A merchant's subscription request (or the subscription it became); the first owner to read it is bound to it. */
  readonly subscription: (id: string) => Promise<SubscriptionView>
  /** The owner's signed subscriptions, newest first. */
  readonly subscriptions: () => Promise<readonly SubscriptionView[]>
}
