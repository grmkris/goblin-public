import type { ServerProfile, WalletStatus } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

// First-class servers (ADR 0043): servers goblin supports by its own profile, matched by endpoint. A profile is ours,
// never the server's claim about itself; what a status tool answers is still the server's data, decoded here with
// goblin's own schema and bounded before the owner sees it.

/** A profile, with how goblin reads the server's status tool. */
type Profile = ServerProfile & {
  /** The endpoints it is known at, exactly. */
  readonly endpoints: readonly string[]
  /** The status tool, and how goblin reads its structured answer; nothing when it does not fit. */
  readonly statusTool?: { readonly name: string; readonly read: (structured: unknown) => WalletStatus | undefined }
  /** Scopes asked for at sign-in beside those the resource offers, when its own list is too narrow for the work. */
  readonly scope?: readonly string[]
  /**
   * The tool that pays one MPP challenge for goblin's paid inference (ADR 0047): reached only by the `inference` caller,
   * kept from the model by the server's App-only visibility.
   */
  readonly payment?: { readonly tool: string }
}

const Readiness = Schema.Literals(['ready', 'blocked', 'not_verified'])
const Amount = Schema.String

/** The part of Mercator's `get_connection_status` answer goblin reads; anything else in it is ignored. */
const MercatorStatus = Schema.Struct({
  readiness: Schema.Struct({
    funding: Readiness,
    paidExecution: Readiness,
    tokens: Schema.Array(
      Schema.Struct({
        symbol: Schema.String,
        balance: Schema.optional(Amount),
        remainingAllowance: Schema.optional(Amount),
        spendableNow: Schema.optional(Amount),
      }),
    ),
  }),
  account: Schema.optional(
    Schema.Struct({
      accessKey: Schema.optional(Schema.Struct({ expiresAt: Schema.optional(Schema.NullOr(Schema.String)) })),
      tokens: Schema.optional(
        Schema.Array(
          Schema.Struct({
            authorization: Schema.optional(Schema.Struct({ periodEndsAt: Schema.optional(Schema.String) })),
          }),
        ),
      ),
    }),
  ),
})
const decodeMercator = Schema.decodeUnknownOption(MercatorStatus)

/** At most this many characters of any one value the server reports, and this many tokens. */
const SHORT = 64
const TOKENS = 8
const short = (value: string): string => value.slice(0, SHORT)
const optionalShort = (key: string, value: string | null | undefined) =>
  value === undefined || value === null ? {} : { [key]: short(value) }

/** The wallet goblin shows, with every value cut to `SHORT` and at most `TOKENS` tokens. */
type Reported = {
  readonly paid: WalletStatus['paid']
  readonly funding: WalletStatus['funding']
  readonly tokens: ReadonlyArray<{
    readonly symbol: string
    readonly balance?: string | undefined
    readonly remaining?: string | undefined
    readonly spendable?: string | undefined
  }>
  readonly periodEndsAt?: string | null | undefined
  readonly expiresAt?: string | null | undefined
}
const shaped = ({ paid, funding, tokens, periodEndsAt, expiresAt }: Reported): WalletStatus => ({
  kind: 'wallet' as const,
  paid,
  funding,
  tokens: tokens.slice(0, TOKENS).map((token) => ({
    symbol: short(token.symbol),
    ...optionalShort('balance', token.balance),
    ...optionalShort('remaining', token.remaining),
    ...optionalShort('spendable', token.spendable),
  })),
  ...optionalShort('periodEndsAt', periodEndsAt),
  ...optionalShort('expiresAt', expiresAt),
})

/** Mercator's wallet, read from its status tool: readiness, balances and limits, and when they run out. */
export const mercatorWallet = (structured: unknown): WalletStatus | undefined =>
  Option.getOrUndefined(
    Option.map(decodeMercator(structured), ({ readiness, account }) =>
      shaped({
        paid: readiness.paidExecution,
        funding: readiness.funding,
        tokens: readiness.tokens.map(({ symbol, balance, remainingAllowance, spendableNow }) => ({
          symbol,
          balance,
          remaining: remainingAllowance,
          spendable: spendableNow,
        })),
        periodEndsAt: account?.tokens?.find((token) => token.authorization?.periodEndsAt !== undefined)?.authorization
          ?.periodEndsAt,
        expiresAt: account?.accessKey?.expiresAt,
      }),
    ),
  )

/** The part of Goblin Wallet's `wallet_status` answer goblin reads: its `status`, which has goblin's own shape. */
const GoblinWalletStatus = Schema.Struct({
  status: Schema.Struct({
    paid: Readiness,
    funding: Readiness,
    tokens: Schema.Array(
      Schema.Struct({
        symbol: Schema.String,
        balance: Schema.optional(Amount),
        remaining: Schema.optional(Amount),
        spendable: Schema.optional(Amount),
      }),
    ),
    periodEndsAt: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.String),
  }),
})
const decodeGoblinWallet = Schema.decodeUnknownOption(GoblinWalletStatus)

/** Goblin Wallet's status, read from `structuredContent.status` of its status tool. */
export const goblinWallet = (structured: unknown): WalletStatus | undefined =>
  Option.getOrUndefined(Option.map(decodeGoblinWallet(structured), ({ status }) => shaped(status)))

/** Mercator (ADR 0043): search and paid outside tasks, paid from the owner's Mercator wallet. */
const MERCATOR: Profile = {
  id: 'mercator',
  endpoints: ['https://mercator.sh/mcp/auth'],
  title: 'Mercator',
  description:
    'Search the web and get outside work done: it finds a service, quotes it for free, and runs it as a paid job from your Mercator wallet.',
  offer: 'so goblin can search the web and get outside work done',
  recommended: {
    run: [
      'get_suggested_queries',
      'get_connection_status',
      'search_services',
      'describe_service',
      'quote_plan',
      'get_job',
      'get_job_details',
      'list_jobs',
      // Only the owner opens its App (its visibility is App-only), and the grant covers the App's resource.
      'open_mercator',
    ],
    ask: ['create_job'],
  },
  spend: { tool: 'create_job', argument: 'approved_total', currency: 'USD' },
  app: { tool: 'open_mercator' },
  status: true,
  statusTool: { name: 'get_connection_status', read: mercatorWallet },
  // Its `fund_wallet` tool hands the owner off to this page; the Agentic Wallet's top-up takes the slot once it exists.
  topUp: { url: 'https://mercator.sh/account' },
}

/**
 * Cloudflare's API (ADR 0043): publishing a page as a Worker on the owner's account. Its resource offers only
 * `user:read account:read`, so goblin also asks for the Workers scripts scopes and nothing wider; `execute` runs
 * any API call those scopes allow, so it asks first.
 */
const CLOUDFLARE: Profile = {
  id: 'cloudflare',
  endpoints: ['https://mcp.cloudflare.com/mcp'],
  title: 'Cloudflare',
  description:
    'Publish a page or a small app as a Worker on your Cloudflare account. Every change asks you first; looking up the API does not.',
  offer: 'so goblin can publish pages and small apps on your Cloudflare account',
  recommended: { run: ['search', 'docs', 'whoami'], ask: ['execute'] },
  status: false,
  scope: ['offline_access', 'user:read', 'account:read', 'workers-scripts.read', 'workers-scripts.write'],
}

/**
 * Goblin Wallet: the owner's wallet for the agent, balances on four chains, limits the owner sets, and receipts. It pays
 * for search and outside services over x402 and MPP; anything that moves funds asks first, and `paid_fetch` is held to
 * the spending rule by its `max_usd`.
 */
const WALLET: Profile = {
  id: 'wallet',
  endpoints: ['https://wallet-dev.goblin.surf/mcp', 'https://wallet.goblin.surf/mcp'],
  title: 'Goblin Wallet',
  description:
    "Your agent's wallet: balances on Base, Ethereum, Arbitrum and Tempo, limits you set, and receipts. It pays for search and other services over x402 and MPP, and moves funds only within your limits.",
  offer: 'so goblin can pay for search and outside services within limits you set',
  recommended: {
    run: [
      'wallet_status',
      'balances',
      'allowances',
      'services',
      'operation',
      'operation_check',
      'receipt',
      'wallet_open',
      'wallet_home',
      'swap_quote',
      'bridge_quote',
      // Paid inference's payments: within the wallet's own limits, and never visible to the model (ADR 0047).
      'pay_challenge',
    ],
    ask: ['paid_fetch', 'transfer', 'swap_execute', 'bridge_execute', 'request_policy_change'],
  },
  spend: { tool: 'paid_fetch', argument: 'max_usd', currency: 'USD' },
  app: { tool: 'wallet_open' },
  status: true,
  statusTool: { name: 'wallet_status', read: goblinWallet },
  payment: { tool: 'pay_challenge' },
}

const PROFILES: readonly Profile[] = [MERCATOR, CLOUDFLARE, WALLET]

/** The profile of the server at `endpoint`, when goblin supports it first-class. */
export const profileOf = (endpoint: string): Profile | undefined =>
  PROFILES.find((profile) => profile.endpoints.includes(endpoint))

/** A profile as the owner's view carries it: everything but how goblin reads the server. */
export const profileView = ({
  endpoints: _,
  statusTool: __,
  scope: ___,
  payment: ____,
  ...view
}: Profile): ServerProfile => view
