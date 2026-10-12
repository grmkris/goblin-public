/**
 * The Privy policy the agent signer is held to: what this service can make the agent wallet sign or send, whatever it
 * asks. Privy evaluates it before every signature; DENY wins, then any ALLOW, else the request is refused. Built per
 * chain from `@goblin/wallet/chains`, ported from Sidequest's `scripts/privy/policy.ts`.
 *
 * - USDC EIP-3009 `TransferWithAuthorization` (x402 `exact`) from the agent's own wallet, at most the payment cap.
 * - The agent sends on EVM chains only as UserOperations (`eth_signUserOperation`); Privy checks every call of the
 *   batch against the rules below. The transitional `transaction` form allows the same calls as plain transactions.
 * - `redeemDelegations` on the MetaMask DelegationManager with no value: the owner's ERC-7710 allowance, whose caveats
 *   (ERC20PeriodTransfer, AllowedTargets, AllowedCalldata, Timestamp) the chain enforces.
 * - USDC `transfer` of at most the payment cap, with no value.
 * - USDC `approve` to Pimlico's ERC-20 paymaster of at most the chain's gas ceiling: the gas, paid in USDC.
 * - Tempo: a type-118 transaction signed (never sent by Privy) whose call is USDC.e `transfer` or `transferWithMemo`
 *   (MPP's charge), at most the payment cap.
 * - Routes (LI.FI's diamond for swaps, Relay's depository for bridges): a USDC `approve` of at most the cap to the
 *   route, and calls to the route with no value attached. The approval bounds what the route can pull.
 * - EIP-7702 only to the MetaMask DeleGator, and private key export denied.
 *
 * What Privy cannot see stays with the ledger and the rails: the payee and validity window of an x402 payment, the
 * redemption's delegation and execution, a route call's own calldata, and a Tempo transaction's other calls.
 */
import { AGENT_GAS_CEILINGS } from '../balances/agent-send.ts'
import { ARBITRUM, BASE, type Chain, ETHEREUM } from '../chains/index.ts'
import { canonicalJson } from '../contract/hash.ts'

/** Privy refuses policy names of 50 characters or more. */
export const AGENT_POLICY_NAME = 'Goblin Wallet agent signer v2'

/** The most one payment may move, in USDC (6 decimals) base units: the ledger's $5 per-call limit. */
export const PAYMENT_CAP_UNITS = 5_000_000n

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json }

export interface PolicyCondition {
  readonly field_source: string
  readonly field: string
  readonly operator: 'eq' | 'lte' | 'gte' | 'in'
  readonly value: string | readonly string[]
  readonly typed_data?: Json
  readonly abi?: Json
}

export interface PolicyRule {
  readonly name: string
  readonly method: string
  readonly action: 'ALLOW' | 'DENY'
  readonly conditions: readonly PolicyCondition[]
}

export interface PolicyDocument {
  readonly version: '1.0'
  readonly name: string
  readonly chain_type: 'ethereum'
  readonly owner_id: string
  readonly rules: readonly PolicyRule[]
}

const DOMAIN_TYPES = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
]

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
}

const fn = (name: string, inputs: readonly (readonly [string, string])[], outputs: readonly string[] = []): Json => [
  {
    type: 'function',
    name,
    stateMutability: 'nonpayable',
    inputs: inputs.map(([inputName, type]) => ({ name: inputName, type })),
    outputs: outputs.map((type) => ({ name: '', type })),
  },
]

const REDEEM_ABI = fn('redeemDelegations', [
  ['_permissionContexts', 'bytes[]'],
  ['_modes', 'bytes32[]'],
  ['_executionCallDatas', 'bytes[]'],
])
const TRANSFER_ABI = fn(
  'transfer',
  [
    ['to', 'address'],
    ['amount', 'uint256'],
  ],
  ['bool'],
)
const APPROVE_ABI = fn(
  'approve',
  [
    ['spender', 'address'],
    ['amount', 'uint256'],
  ],
  ['bool'],
)
const TRANSFER_WITH_MEMO_ABI = fn('transferWithMemo', [
  ['to', 'address'],
  ['amount', 'uint256'],
  ['memo', 'bytes32'],
])

const hex = (value: bigint): string => `0x${value.toString(16)}`

const tx = (field: string, operator: PolicyCondition['operator'], value: string): PolicyCondition => ({
  field_source: 'ethereum_transaction',
  field,
  operator,
  value,
})
const calldata = (abi: Json, field: string, operator: PolicyCondition['operator'], value: string): PolicyCondition => ({
  field_source: 'ethereum_calldata',
  abi,
  field,
  operator,
  value,
})

/** x402 `exact`: the agent's own USDC authorization on this chain, at most the cap. */
const paymentRule = (chain: Chain, cap: bigint): PolicyRule => {
  const typedData = {
    types: { EIP712Domain: DOMAIN_TYPES, ...TRANSFER_WITH_AUTHORIZATION_TYPES },
    primary_type: 'TransferWithAuthorization',
  }
  const message = (field: string, operator: PolicyCondition['operator'], value: string): PolicyCondition => ({
    field_source: 'ethereum_typed_data_message',
    typed_data: typedData,
    field,
    operator,
    value,
  })
  return {
    name: `USDC payment on ${chain.id}`,
    method: 'eth_signTypedData_v4',
    action: 'ALLOW',
    conditions: [
      { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: String(chain.id) },
      {
        field_source: 'ethereum_typed_data_domain',
        field: 'verifyingContract',
        operator: 'eq',
        value: chain.usdc.address,
      },
      message('from', 'eq', '{{wallet.address}}'),
      message('value', 'lte', cap.toString()),
    ],
  }
}

/** How the agent sends on an EVM chain: a UserOperation, or (transitional) a plain transaction. */
export type AgentSendForm = 'userop' | 'transaction'

const METHOD: Readonly<Record<AgentSendForm, string>> = {
  userop: 'eth_signUserOperation',
  transaction: 'eth_sendTransaction',
}
const named = (what: string, form: AgentSendForm, chainId: number): string =>
  `${what}${form === 'userop' ? ' userOp' : ''} on ${chainId}`

/** The owner's allowance (or a subscription): `redeemDelegations` on the DelegationManager, no value attached. */
const redeemRule = (chain: Chain, form: AgentSendForm, what = 'Redeem allowance'): PolicyRule => ({
  name: named(what, form, chain.id),
  method: METHOD[form],
  action: 'ALLOW',
  conditions: [
    tx('chain_id', 'eq', String(chain.id)),
    tx('to', 'eq', chain.delegation.manager),
    tx('value', 'lte', '0x0'),
    calldata(REDEEM_ABI, 'function_name', 'eq', 'redeemDelegations'),
  ],
})

/** A plain USDC transfer from the agent wallet, at most the cap. */
const transferRule = (chain: Chain, cap: bigint, form: AgentSendForm): PolicyRule => ({
  name: named('USDC transfer', form, chain.id),
  method: METHOD[form],
  action: 'ALLOW',
  conditions: [
    tx('chain_id', 'eq', String(chain.id)),
    tx('to', 'eq', chain.usdc.address),
    tx('value', 'lte', '0x0'),
    calldata(TRANSFER_ABI, 'transfer.amount', 'lte', hex(cap)),
  ],
})

const GAS_CEILING_BY_CHAIN = new Map<number, bigint>([
  [BASE.id, AGENT_GAS_CEILINGS.base],
  [ARBITRUM.id, AGENT_GAS_CEILINGS.arbitrum],
  [ETHEREUM.id, AGENT_GAS_CEILINGS.ethereum],
])

/** The gas of a UserOperation, in USDC: an approval to the chain's ERC-20 paymaster of at most its gas ceiling. */
const paymasterRule = (chain: Chain): PolicyRule[] =>
  chain.aa === null
    ? []
    : [
        {
          name: `USDC approve paymaster userOp on ${chain.id}`,
          method: METHOD.userop,
          action: 'ALLOW',
          conditions: [
            tx('chain_id', 'eq', String(chain.id)),
            tx('to', 'eq', chain.usdc.address),
            tx('value', 'lte', '0x0'),
            calldata(APPROVE_ABI, 'approve.spender', 'eq', chain.aa.paymaster),
            calldata(APPROVE_ABI, 'approve.amount', 'lte', hex(GAS_CEILING_BY_CHAIN.get(chain.id) ?? 0n)),
          ],
        },
      ]

/** A contract the agent may route USDC through on one chain (a swap or bridge contract), by name for the rule. */
export interface RouteSpender {
  readonly chain: Chain
  readonly name: string
  readonly address: string
}

/** The route's USDC approval (at most the cap), and calls to the route without native value. */
const routeRules = (route: RouteSpender, cap: bigint, form: AgentSendForm): PolicyRule[] => [
  {
    name: named(`USDC approve ${route.name}`, form, route.chain.id),
    method: METHOD[form],
    action: 'ALLOW',
    conditions: [
      tx('chain_id', 'eq', String(route.chain.id)),
      tx('to', 'eq', route.chain.usdc.address),
      tx('value', 'lte', '0x0'),
      calldata(APPROVE_ABI, 'approve.spender', 'eq', route.address),
      calldata(APPROVE_ABI, 'approve.amount', 'lte', hex(cap)),
    ],
  },
  {
    name: named(`${route.name} call`, form, route.chain.id),
    method: METHOD[form],
    action: 'ALLOW',
    conditions: [
      tx('chain_id', 'eq', String(route.chain.id)),
      tx('to', 'eq', route.address),
      tx('value', 'lte', '0x0'),
    ],
  },
]

/** Tempo: Privy signs a type-118 transaction calling USDC.e `transfer` or `transferWithMemo`, at most the cap. */
const tempoRules = (chain: Chain, cap: bigint): PolicyRule[] =>
  (
    [
      ['transfer', TRANSFER_ABI],
      ['transferWithMemo', TRANSFER_WITH_MEMO_ABI],
    ] as const
  ).map(([name, abi]) => ({
    name: `USDC.e ${name} on ${chain.id}`,
    method: 'eth_signTransaction',
    action: 'ALLOW',
    conditions: [
      tx('chain_id', 'eq', String(chain.id)),
      tx('to', 'eq', chain.usdc.address),
      calldata(abi, `${name}.amount`, 'lte', hex(cap)),
    ],
  }))

export interface AgentPolicyInput {
  /** The policy-admin key quorum: the only key that may change the policy. It is never deployed. */
  readonly ownerId: string
  /** The chains to allow; an EVM chain with EIP-3009 USDC gets the payment, redeem and transfer rules, Tempo its own. */
  readonly chains: readonly Chain[]
  /** Swap and bridge contracts the agent may approve USDC to and call. */
  readonly routes?: readonly RouteSpender[]
  readonly capUnits?: bigint
  /** How the agent sends: UserOperations only (the default), or both forms while deployments switch over. */
  readonly forms?: readonly AgentSendForm[]
}

/** The agent policy document, exactly as Privy stores it (minus ids). */
export const agentPolicy = (input: AgentPolicyInput): PolicyDocument => {
  const cap = input.capUnits ?? PAYMENT_CAP_UNITS
  const delegators = new Set(input.chains.map((chain) => chain.delegation.delegator))
  if (delegators.size !== 1) throw new Error('invalid_policy: the chains must share one DeleGator deployment')
  const forms = input.forms ?? ['userop']
  const sends = (chain: Chain): PolicyRule[] =>
    forms.flatMap((form) => [
      redeemRule(chain, form),
      transferRule(chain, cap, form),
      ...(form === 'userop' ? paymasterRule(chain) : []),
    ])
  const perChain = input.chains.flatMap((chain) =>
    chain.usdc.eip3009 === null ? tempoRules(chain, cap) : [paymentRule(chain, cap), ...sends(chain)],
  )
  const routes = (input.routes ?? []).flatMap((route) => forms.flatMap((form) => routeRules(route, cap, form)))
  return {
    version: '1.0',
    name: AGENT_POLICY_NAME,
    chain_type: 'ethereum',
    owner_id: input.ownerId,
    rules: [...perChain, ...routes, ...accountRules([...delegators][0] ?? '')],
  }
}

/** Every wallet's last two rules: EIP-7702 only to the MetaMask DeleGator, and private key export denied. */
const accountRules = (delegator: string): PolicyRule[] => [
  {
    name: 'Allow DeleGator upgrade',
    method: 'eth_sign7702Authorization',
    action: 'ALLOW',
    conditions: [{ field_source: 'ethereum_7702_authorization', field: 'contract', operator: 'eq', value: delegator }],
  },
  { name: 'Deny export', method: 'exportPrivateKey', action: 'DENY', conditions: [] },
]

/** Privy refuses policy names of 50 characters or more. */
export const COLLECTOR_POLICY_NAME = 'Goblin Wallet collector v1'

/**
 * The policy the collector's signer is held to (ADR 0054): goblin's collector, a server wallet the project's admins own,
 * signs only UserOperations that redeem a delegation on the DelegationManager (a subscription, whose caveats pin the
 * recipient to the collector itself and cap each period) and approve the chain's ERC-20 paymaster for at most the gas
 * ceiling in USDC, plus its own one-time EIP-7702 upgrade to the DeleGator. It never transfers, approves a route or
 * signs typed data; the admins move what it collects outside this policy.
 */
export const collectorPolicy = (input: {
  readonly ownerId: string
  readonly chains: readonly Chain[]
}): PolicyDocument => {
  const delegators = new Set(input.chains.map((chain) => chain.delegation.delegator))
  if (delegators.size !== 1) throw new Error('invalid_policy: the chains must share one DeleGator deployment')
  return {
    version: '1.0',
    name: COLLECTOR_POLICY_NAME,
    chain_type: 'ethereum',
    owner_id: input.ownerId,
    rules: [
      ...input.chains.flatMap((chain) => [redeemRule(chain, 'userop', 'Redeem subscription'), ...paymasterRule(chain)]),
      ...accountRules([...delegators][0] ?? ''),
    ],
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const WRITABLE = new Set(['id', 'created_at', 'version', 'name', 'chain_type', 'owner_id', 'rules'])

/** A live policy as a document to compare: ids and timestamps dropped. Refuses fields this code does not know. */
export const writablePolicy = (live: Record<string, unknown>): Record<string, unknown> => {
  const rules = live['rules']
  if (Object.keys(live).some((key) => !WRITABLE.has(key)) || !Array.isArray(rules))
    throw new Error('invalid_policy: unexpected fields in the live policy; refusing to update it')
  const { id: _id, created_at: _createdAt, ...body } = live
  return {
    ...body,
    rules: rules.map((rule) => {
      if (!isRecord(rule)) throw new Error('invalid_policy: a rule is not an object')
      const { id: _ruleId, ...rest } = rule
      return rest
    }),
  }
}

/** Two policy documents are the same policy when their canonical JSON is. */
export const samePolicy = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const RELAY_DEPOSITORY = '0x4cD00E387622C35bDDB9b4c962C136462338BC31'

/** The swap and bridge contracts the rails use: LI.FI's diamond on Base, Relay's depository on every EVM origin. */
export const AGENT_ROUTES: readonly RouteSpender[] = [
  { chain: BASE, name: 'LI.FI', address: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
  { chain: BASE, name: 'Relay', address: RELAY_DEPOSITORY },
  { chain: ARBITRUM, name: 'Relay', address: RELAY_DEPOSITORY },
  { chain: ETHEREUM, name: 'Relay', address: RELAY_DEPOSITORY },
]
