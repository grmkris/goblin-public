import { SETUP_GAPS, SETUP_GAP_LENGTH, type ServerProfile, type WalletStatus } from '@goblin/contracts'
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
  /**
   * The tool that tops up a prepaid server's own balance (ADR 0049): reached by the `funding` caller only, and only as a
   * top-up goblin recorded under the owner's rule, to the address the prepaid server's own status reports.
   */
  readonly funding?: { readonly tool: string }
}

const Readiness = Schema.Literals(['ready', 'blocked', 'not_verified'])
const Amount = Schema.String

/** An EVM address, and the one a wallet reports when it has none yet. */
const Address = Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u))
const NO_ADDRESS = /^0x0{40}$/u

/** An address goblin may send funds to: a real EVM address, not the zero one; anything else is no address at all. */
const fundable = (address: string | undefined): address is string =>
  address !== undefined && Schema.is(Address)(address) && !NO_ADDRESS.test(address)

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
      /** The owner's Mercator wallet on Tempo, where its balance is funded (its output schema, 2026-10-12). */
      walletAddress: Schema.optional(Schema.String),
    }),
  ),
})
const decodeMercator = Schema.decodeUnknownOption(MercatorStatus)

/** Mercator's balance is USDC.e on Tempo (its Tempo Wallet payments); goblin funds it there (ADR 0049). */
const MERCATOR_BALANCE = { chain: 'tempo', token: 'USDC.e' } as const

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
  readonly stablecoinUsd?: string | undefined
  readonly stablecoinUsdPartial?: true | undefined
  readonly payFrom?:
    | { readonly address: string; readonly chain: string; readonly token: string; readonly held?: string | undefined }
    | undefined
  readonly depositTo?: { readonly address: string; readonly chain: string; readonly token: string } | undefined
  readonly setup?: readonly string[] | undefined
}

/** The setup gaps a wallet reports, bounded: at most `SETUP_GAPS`, each cut to `SETUP_GAP_LENGTH`, blank ones dropped. */
const gapsOf = (setup: readonly string[] | undefined): readonly string[] =>
  (setup ?? [])
    .map((gap) => gap.trim().slice(0, SETUP_GAP_LENGTH))
    .filter((gap) => gap !== '')
    .slice(0, SETUP_GAPS)

const shaped = ({
  paid,
  funding,
  tokens,
  periodEndsAt,
  expiresAt,
  stablecoinUsd,
  stablecoinUsdPartial,
  payFrom,
  depositTo,
  setup,
}: Reported): WalletStatus => ({
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
  ...optionalShort('stablecoinUsd', stablecoinUsd),
  ...(stablecoinUsdPartial === true ? { stablecoinUsdPartial } : {}),
  ...(payFrom === undefined
    ? {}
    : {
        payFrom: {
          address: short(payFrom.address),
          chain: short(payFrom.chain),
          token: short(payFrom.token),
          ...optionalShort('held', payFrom.held),
        },
      }),
  ...(depositTo === undefined
    ? {}
    : {
        depositTo: { address: short(depositTo.address), chain: short(depositTo.chain), token: short(depositTo.token) },
      }),
  ...(gapsOf(setup).length === 0 ? {} : { setup: gapsOf(setup) }),
})

/**
 * Mercator's wallet, read from its status tool: readiness, balances and limits, when they run out, and where its
 * balance is funded (its wallet address, on Tempo in USDC.e).
 */
export const mercatorWallet = (structured: unknown): WalletStatus | undefined =>
  Option.getOrUndefined(
    Option.map(decodeMercator(structured), ({ readiness, account }) =>
      shaped({
        depositTo: fundable(account?.walletAddress)
          ? { address: account.walletAddress, ...MERCATOR_BALANCE }
          : undefined,
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

/**
 * The part of Goblin Wallet's `wallet_status` answer goblin reads: its `status`, which has goblin's own shape, where the
 * agent pays from (`payFrom`, absent until the agent wallet exists), and what the owner still has to set up on the
 * wallet's own site (`setup`, its short phrases, absent when nothing is left).
 */
const GoblinWalletStatus = Schema.Struct({
  setup: Schema.optional(Schema.Array(Schema.String)),
  payFrom: Schema.optional(
    Schema.Struct({ address: Address, chain: Schema.String, token: Schema.String, held: Schema.optional(Amount) }),
  ),
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
    stablecoinUsd: Schema.optional(Amount),
    stablecoinUsdPartial: Schema.optional(Schema.Literal(true)),
  }),
})
const decodeGoblinWallet = Schema.decodeUnknownOption(GoblinWalletStatus)

/**
 * Goblin Wallet's status, read from `structuredContent.status` of its status tool, with the address it pays from and
 * the setup it says is left.
 */
export const goblinWallet = (structured: unknown): WalletStatus | undefined =>
  Option.getOrUndefined(
    Option.map(decodeGoblinWallet(structured), ({ status, payFrom, setup }) =>
      shaped({
        ...status,
        payFrom: payFrom === undefined || NO_ADDRESS.test(payFrom.address) ? undefined : payFrom,
        setup,
      }),
    ),
  )

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
  // goblin tops its balance up from the Goblin Wallet before a job it is short for (ADR 0049).
  prepaid: { ...MERCATOR_BALANCE, perTopUp: '5', daily: '20' },
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
      // Funding the agent from any chain: a deposit address and its progress; they sign and spend nothing.
      'add_funds',
      'add_funds_status',
      'view_state',
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
  funding: { tool: 'transfer' },
}

const PROFILES: readonly Profile[] = [MERCATOR, CLOUDFLARE, WALLET]

/**
 * The Goblin Wallet's own setup page for the connection at `endpoint`: it runs the wallet's setup (and adding funds)
 * and returns to `back`, an address on goblin. It is on the endpoint's origin, which is goblin's own configuration,
 * never a site the server names; the wallet returns only to the origin of a client the owner connected.
 */
export const walletSetupUrl = (endpoint: string, back: string): string =>
  `${new URL('/setup', new URL(endpoint).origin).href}?return=${encodeURIComponent(back)}`

/** The profile of the server at `endpoint`, when goblin supports it first-class. */
export const profileOf = (endpoint: string): Profile | undefined =>
  PROFILES.find((profile) => profile.endpoints.includes(endpoint))

/** A profile as the owner's view carries it: everything but how goblin reads the server. */
export const profileView = ({
  endpoints: _,
  statusTool: __,
  scope: ___,
  payment: ____,
  funding: _____,
  ...view
}: Profile): ServerProfile => view
