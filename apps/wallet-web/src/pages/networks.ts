import type { Me } from '@goblin/wallet/contract'
import type { OwnerChain } from '../app/auth.tsx'

/** The chains Home offers once onboarding finished on Base, in the order the card lists them. */
export const OTHER_CHAINS: readonly OwnerChain[] = ['arbitrum', 'ethereum']

/** Where the owner stands on one chain, from server state only, so a refresh or a second device shows the same. */
export type NetworkState =
  | { readonly kind: 'not_upgraded' }
  | { readonly kind: 'upgraded' }
  | { readonly kind: 'active'; readonly perHour: string; readonly expiresAt: string }
  | { readonly kind: 'expired'; readonly perHour: string; readonly expiresAt: string }

/**
 * One chain's state. An allowance on an account that is not upgraded cannot be redeemed, so the upgrade comes first
 * whatever else is recorded; an allowance past its expiry is `expired` and the owner can set a new one.
 */
export function networkState(me: Me, chain: OwnerChain, now: number = Date.now()): NetworkState {
  const setup = me.chains.find((entry) => entry.chain === chain)
  if (setup?.upgraded !== true) return { kind: 'not_upgraded' }
  if (setup.allowance === undefined) return { kind: 'upgraded' }
  const { perHour, expiresAt } = setup.allowance
  return Date.parse(expiresAt) > now ? { kind: 'active', perHour, expiresAt } : { kind: 'expired', perHour, expiresAt }
}

/** Home offers the other chains only once Base is upgraded and has an allowance. */
export function showsOtherNetworks(me: Me): boolean {
  const base = me.chains.find((entry) => entry.chain === 'base')
  return base?.upgraded === true && base.allowance !== undefined
}
