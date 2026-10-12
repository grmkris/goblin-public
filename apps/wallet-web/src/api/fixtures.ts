// Fixture data for every page: the demo owner, an agent mid-day, a mix of operations in every state. Times are relative
// to the load so "5 min ago" stays true. `?fixtures` in the URL shows these instead of calling the API (screenshots).
import type {
  ApprovalView,
  Connection,
  LimitView,
  Me,
  Operation,
  PolicyChange,
  Recipient,
  ServiceRule,
  Terms,
  WalletStatusResult,
} from '@goblin/wallet/contract'
import { DEFAULT_SERVICES } from '@goblin/wallet/contract'

const now = Date.now()
const ago = (minutes: number): string => new Date(now - minutes * 60_000).toISOString()
const ahead = (minutes: number): string => new Date(now + minutes * 60_000).toISOString()

export const OWNER = '0x4f1B7c0a2D9e3b86A5c1E7f09d4B2a6C8e3F5a17'
export const AGENT = '0x9aC3e1D5b7F20846c1A9d3E5f7B2048a6C1e9D3b'
const EXA = '0xE8a1b2C3d4E5f60718293a4B5c6D7e8F90a1B2c3'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const tx = (seed: string): string => `0x${seed.repeat(64).slice(0, 64)}`

const searchTerms: Terms = {
  kind: 'paid_fetch',
  chain: 'base',
  rail: 'x402',
  subject: 'Exa search',
  token: { symbol: 'USDC', address: USDC_BASE, decimals: 6 },
  amount: '0.007',
  amountUsd: '0.007',
  recipient: EXA,
  request: { method: 'POST', url: 'https://api.exa.ai/search' },
  expiresAt: ahead(10),
}

const op = (
  id: string,
  minutes: number,
  patch: Omit<Partial<Operation>, 'terms'> & { terms?: Partial<Terms> },
): Operation => {
  const { terms, ...rest } = patch
  return {
    id,
    status: 'delivered',
    terms: { ...searchTerms, ...terms },
    termsHash: tx('ab'),
    limitsVersion: 3,
    createdAt: ago(minutes),
    updatedAt: ago(minutes),
    ...rest,
  }
}

export const OPERATIONS: readonly Operation[] = [
  op('op_pending_01', 1, {
    status: 'awaiting_approval',
    terms: {
      subject: 'Crunchbase company dossier',
      amount: '6',
      amountUsd: '6',
      request: { method: 'POST', url: 'https://api.crunchbase.example/dossier' },
    },
  }),
  op('op_search_0042', 4, {
    payment: { rail: 'x402', txHash: tx('c1'), settledAt: ago(4) },
    delivery: { status: '200' },
  }),
  op('op_search_0041', 9, {
    status: 'confirmed',
    terms: { subject: 'Exa page contents', amount: '0.012', amountUsd: '0.012' },
    payment: { rail: 'x402', txHash: tx('d2'), settledAt: ago(9) },
  }),
  op('op_search_0040', 21, {
    status: 'uncertain',
    reason: 'The payment was sent but the network did not confirm. Not retried; check the transaction.',
    payment: { rail: 'x402', txHash: tx('e3') },
  }),
  op('op_search_0039', 37, {
    status: 'failed',
    terms: { rail: 'mpp', chain: 'tempo', amount: '0.05', amountUsd: '0.05', subject: 'Exa search' },
    reason: 'Refused: over the per-call limit of $0.05 for this service.',
  }),
  op('op_search_0038', 190, {
    terms: { subject: 'Exa search', amount: '0.007', amountUsd: '0.007' },
    payment: { rail: 'x402', txHash: tx('f4'), settledAt: ago(190) },
    delivery: { status: '200' },
  }),
  op('op_search_0037', 1500, {
    status: 'declined',
    terms: { subject: 'Unknown service', amount: '2.5', amountUsd: '2.5' },
  }),
]

export const LIMITS: readonly LimitView[] = [
  {
    layer: 'onchain',
    period: 'hour',
    limit: '20',
    used: '7.43',
    remaining: '12.57',
    chain: 'base',
    enforcedBy: 'Base, MetaMask ERC20PeriodTransfer enforcer',
    periodEndsAt: ahead(41),
  },
  {
    layer: 'tempo',
    period: 'hour',
    limit: '10',
    used: '9.4',
    remaining: '0.6',
    chain: 'tempo',
    enforcedBy: 'Tempo access key spending limit',
    periodEndsAt: ahead(41),
  },
  { layer: 'signer', period: 'call', limit: '5', enforcedBy: 'Privy policy on the agent signer' },
  {
    layer: 'ledger',
    period: 'week',
    limit: '50',
    used: '18.9',
    remaining: '31.1',
    enforcedBy: 'This wallet, every payment in every chain',
    periodEndsAt: ahead(60 * 24 * 4),
  },
  {
    layer: 'client',
    period: 'day',
    limit: '2',
    used: '0.62',
    remaining: '1.38',
    enforcedBy: "goblin's spending rules",
    periodEndsAt: ahead(60 * 9),
  },
]

export const ME: Me = {
  userId: 'did:privy:demo',
  owner: OWNER,
  agent: AGENT,
  chains: [
    {
      chain: 'base',
      upgraded: true,
      allowance: { perHour: '20', expiresAt: ahead(60 * 24 * 6), delegationHash: tx('9a') },
    },
    { chain: 'tempo', upgraded: true },
  ],
  limits: { perCall: '5', perHour: '20', perWeek: '50', expiresAt: ahead(60 * 24 * 6), version: 3 },
}

export const STATUS: WalletStatusResult = {
  status: {
    kind: 'wallet',
    paid: 'ready',
    funding: 'ready',
    tokens: [{ symbol: 'USDC', balance: '84.21', remaining: '12.57', spendable: '12.57' }],
    periodEndsAt: ahead(41),
    expiresAt: ahead(60 * 24 * 6),
  },
  owner: { address: OWNER, upgraded: true },
  agent: { address: AGENT },
  balances: [
    { chain: 'base', symbol: 'USDC', token: USDC_BASE, decimals: 6, balance: '62.5', holder: 'owner', address: OWNER },
    { chain: 'base', symbol: 'USDC', token: USDC_BASE, decimals: 6, balance: '1.21', holder: 'agent', address: AGENT },
    {
      chain: 'tempo',
      symbol: 'USDC.e',
      token: '0x20C000000000000000000000b9537d11c60E8b50',
      decimals: 6,
      balance: '20.5',
      holder: 'owner',
      address: OWNER,
    },
  ],
  limits: LIMITS,
  checkedAt: ago(0),
}

export const APPROVAL: ApprovalView = {
  operationId: 'op_pending_01',
  reason: 'over_limit',
  terms: OPERATIONS[0]?.terms ?? searchTerms,
  termsHash: tx('ab'),
  crosses: [LIMITS[2], LIMITS[1]].filter((limit): limit is LimitView => limit !== undefined),
  client: 'goblin',
  status: 'pending',
  expiresAt: ahead(9),
}

export const CONNECTIONS: readonly Connection[] = [
  {
    id: 'conn_goblin',
    client: 'goblin',
    scopes: ['wallet:read', 'wallet:spend'],
    createdAt: ago(60 * 30),
    lastUsedAt: ago(1),
  },
  {
    id: 'conn_claude',
    client: 'Claude Desktop',
    scopes: ['wallet:read'],
    createdAt: ago(60 * 80),
    lastUsedAt: ago(60 * 26),
  },
]

export const SERVICES: readonly ServiceRule[] = DEFAULT_SERVICES

export const ADDRESS_BOOK: readonly Recipient[] = [
  { address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', chain: 'base', label: 'Mari (rent)', addedAt: ago(60 * 70) },
]

export const OAUTH_REQUEST = {
  id: 'req_demo_01',
  client: 'Claude Desktop',
  redirectHost: 'claude.ai',
  scopes: ['wallet:read', 'wallet:spend'],
  expiresAt: ahead(8),
}

export const POLICY_CHANGES: readonly PolicyChange[] = [
  {
    id: 'pc_hourly',
    change: 'Raise the hourly limit to $30',
    reason: 'A batch of 40 searches is queued and would stall at $20 an hour.',
    client: 'goblin',
    status: 'pending',
    createdAt: ago(12),
  },
  {
    id: 'pc_service',
    change: 'Allow a new paid service: api.firecrawl.dev',
    reason: 'I need page contents Exa does not return.',
    client: 'Claude Desktop',
    status: 'applied',
    createdAt: ago(60 * 26),
  },
]
