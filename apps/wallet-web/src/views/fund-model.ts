// What the App's "Pays from" card decides without the network: how much USDC.e the agent holds on Tempo (what paid
// inference and MPP services pay from), whether the wallet is empty, and whether Add funds opens on its own.
import type { WalletStatusResult } from '@goblin/wallet/contract'
import { unitsOf } from './money.ts'

/** The agent's USDC.e on Tempo in base units, or undefined when Tempo was not read or there is no agent yet. */
export function agentOnTempo(status: WalletStatusResult): bigint | undefined {
  const held = status.payFrom?.held
  return held === undefined ? undefined : unitsOf(held, 6)
}

/** Nothing held anywhere that was read, and no unread chain that might hold something: say "Fund this address". */
export const isEmpty = (status: WalletStatusResult): boolean =>
  status.payFrom !== undefined &&
  (status.unread ?? []).length === 0 &&
  status.balances.every((row) => unitsOf(row.balance, row.decimals) === 0n)

/** Add funds opens on its own when the host asked for it, or when there is nothing yet to spend. */
export const opensOnAddFunds = (status: WalletStatusResult): boolean => status.focus === 'add_funds' || isEmpty(status)
