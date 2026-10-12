import type { ChainBalance } from '@goblin/wallet/contract'

/** The sum of balances as a plain decimal string, in integer micro-units so 0.1 + 0.2 stays 0.3. */
export function sumUsd(balances: readonly ChainBalance[]): string {
  const micros = balances.reduce((total, row) => total + microsOf(row.balance), 0)
  const whole = Math.floor(micros / 1_000_000)
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '')
  return fraction === '' ? String(whole) : `${whole}.${fraction}`
}

function microsOf(amount: string): number {
  const [whole = '0', fraction = ''] = amount.split('.')
  return Number(whole) * 1_000_000 + Number(fraction.slice(0, 6).padEnd(6, '0'))
}
