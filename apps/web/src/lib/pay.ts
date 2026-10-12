import type { PayChoice, UsageToday } from '@goblin/contracts'

/**
 * Whether the owner's Goblin Wallet pays once the day's Credits are spent (ADR 0047): always in `wallet` mode, and in
 * `credits-then-wallet` while it can pay. A stage that sells no paid route reads `credits`.
 */
export const walletPaysWhenSpent = (pay: PayChoice): boolean =>
  pay.mode === 'wallet' || (pay.mode === 'credits-then-wallet' && pay.walletReady)

/**
 * Whether goblin's next model call is paid from the owner's Goblin Wallet: every call in `wallet` mode, and in
 * `credits-then-wallet` once the day's Credits are spent while the wallet can pay. The composer says so.
 */
export const payingPerCall = (pay: PayChoice | undefined, usage: UsageToday | undefined): boolean => {
  if (pay === undefined || !walletPaysWhenSpent(pay)) return false
  return pay.mode === 'wallet' || (usage !== undefined && usage.used >= usage.limit)
}
