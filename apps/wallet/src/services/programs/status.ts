import type { LimitView, WalletStatusResult } from '@goblin/wallet/contract'
import * as Clock from 'effect/Clock'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Ledger } from '../ledger.ts'
import { type BalanceRead, Rails } from '../rails.ts'
import { deriveStatus } from './derive-status.ts'

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

/** `wallet_status` and `GET /api/status`: goblin's `WalletStatus` plus what the App shows. */
export const readStatus = Effect.gen(function* () {
  const ledger = yield* Ledger
  const rails = yield* Rails
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
  const result: WalletStatusResult = {
    status,
    owner: {
      address: profile.ownerAddress ?? NO_ADDRESS,
      upgraded: profile.chains.some((chain) => chain.upgraded),
    },
    agent: { address: profile.agentAddress ?? NO_ADDRESS },
    balances,
    ...(unread.length === 0 ? {} : { unread }),
    limits,
    recent,
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
  }
  return result
})
