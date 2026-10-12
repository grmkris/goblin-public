import { formatUnits } from '@goblin/wallet/amounts'
import { FLOAT_LOW, FLOAT_TARGET } from '@goblin/wallet/bridge'
import type {
  ChainBalance,
  ChainKey,
  LimitView,
  PayFrom,
  TempoFloat,
  WalletStatusResult,
} from '@goblin/wallet/contract'
import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Approvals } from '../approvals.ts'
import { Ledger } from '../ledger.ts'
import { type BalanceRead, Rails } from '../rails.ts'
import { deriveStatus } from './derive-status.ts'
import { type FloatSource, floatSource, setupGaps } from './setup.ts'

const NO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** Every limit with the layer that enforces it: the ledger's, then the chain's and the signer's. */
export const readLimits = Effect.gen(function* () {
  const ledger = yield* Ledger
  const rails = yield* Rails
  const mine = yield* ledger.use((api) => api.limitViews())
  // expected: a rail that cannot be read leaves the ledger's own limits, which is still the truth about what we enforce.
  const theirs = yield* rails.use((port) => port.allowances()).pipe(Effect.orElseSucceed((): LimitView[] => []))
  return [...mine, ...theirs]
})

/** The agent's Tempo address and its USDC.e: what paid inference and MPP services pay from. */
const payFromOf = (
  agent: string | undefined,
  balances: readonly ChainBalance[],
  unread: readonly ChainKey[],
): PayFrom | undefined => {
  if (agent === undefined) return undefined
  const row = balances.find((entry) => entry.chain === 'tempo' && entry.holder === 'agent' && entry.symbol === 'USDC.e')
  return {
    address: agent,
    chain: 'tempo',
    token: 'USDC.e',
    ...(unread.includes('tempo') ? {} : { held: row?.balance ?? '0' }),
  }
}

/** The Tempo float as the status shows it: what it holds, its thresholds, and whether the allowance refills it. */
const floatOf = (payFrom: PayFrom, source: FloatSource, refilling: boolean): TempoFloat => ({
  ...(payFrom.held === undefined ? {} : { held: payFrom.held }),
  low: formatUnits(FLOAT_LOW, 6),
  target: formatUnits(FLOAT_TARGET, 6),
  refilling,
  automatic: source === 'allowance',
})

/** The status and where the Tempo float's refills come from (ADR 0051). */
const readStatusParts = Effect.gen(function* () {
  const ledger = yield* Ledger
  const rails = yield* Rails
  const { site } = yield* Approvals
  const now = yield* Clock.currentTimeMillis
  const profile = yield* ledger.use((api) => api.profile())
  const grant = yield* ledger.use((api) => api.limits())
  const revoked = yield* ledger.use((api) => api.isRevoked())
  const limits = yield* readLimits
  const recent = yield* ledger.use((api) => api.activity(10))
  const read = yield* rails.use((port) => port.balances()).pipe(Effect.option)
  const { balances, unread } = Option.getOrElse(read, (): BalanceRead => ({ balances: [], unread: [] }))
  const status = deriveStatus({
    balances,
    unread,
    limits,
    verified: Option.isSome(read),
    hasAgent: profile.agentAddress !== undefined,
    revoked,
    grantExpiresAt: grant.expiresAt,
    now,
  })
  const payFrom = payFromOf(profile.agentAddress, balances, unread)
  const live = Option.isSome(read) && read.value.live === true
  const source = floatSource({ live, chains: profile.chains, limits, balances, now })
  const { refilling } = yield* ledger.use((api) => api.floatState())
  const result: WalletStatusResult = {
    status,
    owner: {
      address: profile.ownerAddress ?? NO_ADDRESS,
      upgraded: profile.chains.some((chain) => chain.upgraded),
    },
    agent: { address: profile.agentAddress ?? NO_ADDRESS },
    ...(payFrom === undefined ? {} : { payFrom, float: floatOf(payFrom, source, refilling) }),
    balances,
    ...(unread.length === 0 ? {} : { unread }),
    limits,
    recent,
    site,
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  }
  return { result, float: { source, refilling } }
})

/** `wallet_status` and `GET /api/status`: goblin's `WalletStatus` plus what the App shows. */
export const readStatus = Effect.map(readStatusParts, ({ result }) => result)

/**
 * `wallet_status` for the agent: the status, what the owner still has to set up, if anything, and where the Tempo
 * float's refills come from.
 */
export const readStatusWithSetup = Effect.gen(function* () {
  const { result, float } = yield* readStatusParts
  const profile = yield* (yield* Ledger).use((api) => api.profile())
  const setup = setupGaps({
    hasAgent: profile.agentAddress !== undefined,
    chains: profile.chains,
    balances: result.balances,
  })
  return { result, setup, float }
})
