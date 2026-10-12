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

/** Mercator's wallet, read from its status tool: readiness, balances and limits, and when they run out. */
export const mercatorWallet = (structured: unknown): WalletStatus | undefined =>
  Option.getOrUndefined(
    Option.map(decodeMercator(structured), ({ readiness, account }) => {
      const periodEndsAt = account?.tokens?.find((token) => token.authorization?.periodEndsAt !== undefined)
        ?.authorization?.periodEndsAt
      return {
        kind: 'wallet' as const,
        paid: readiness.paidExecution,
        funding: readiness.funding,
        tokens: readiness.tokens.slice(0, TOKENS).map((token) => ({
          symbol: short(token.symbol),
          ...optionalShort('balance', token.balance),
          ...optionalShort('remaining', token.remainingAllowance),
          ...optionalShort('spendable', token.spendableNow),
        })),
        ...optionalShort('periodEndsAt', periodEndsAt),
        ...optionalShort('expiresAt', account?.accessKey?.expiresAt),
      }
    }),
  )

/** Mercator (ADR 0043): search and paid outside tasks, paid from the owner's Mercator wallet. */
const MERCATOR: Profile = {
  id: 'mercator',
  endpoints: ['https://mercator.sh/mcp/auth'],
  title: 'Mercator',
  description:
    'Search the web and get outside work done: it finds a service, quotes it for free, and runs it as a paid job from your Mercator wallet.',
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
}

const PROFILES: readonly Profile[] = [MERCATOR]

/** The profile of the server at `endpoint`, when goblin supports it first-class. */
export const profileOf = (endpoint: string): Profile | undefined =>
  PROFILES.find((profile) => profile.endpoints.includes(endpoint))

/** A profile as the owner's view carries it: everything but how goblin reads the server. */
export const profileView = ({ endpoints: _, statusTool: __, ...view }: Profile): ServerProfile => view
