import type { ChainBalance } from '@goblin/wallet/contract'

/** The USD stablecoins the wallet counts at face value. ETH and other tokens are listed, never added as dollars. */
const STABLES = new Set(['USDC', 'USDC.e', 'pathUSD'])

export const isStable = (symbol: string): boolean => STABLES.has(symbol)

/** Dollars held: the stablecoin balances added, in integer micro-units so 0.1 + 0.2 stays 0.3. */
export function sumUsd(balances: readonly ChainBalance[]): string {
  return addDecimals(balances.filter((row) => isStable(row.symbol)).map((row) => row.balance))
}

/** What the agent can spend now: each stablecoin's spendable figure from the status, added. ETH pays gas, not services. */
export function spendableUsd(
  tokens: readonly { readonly symbol: string; readonly spendable?: string | undefined }[],
): string {
  return addDecimals(tokens.filter((token) => isStable(token.symbol)).map((token) => token.spendable ?? '0'))
}

function addDecimals(amounts: readonly string[]): string {
  const micros = amounts.reduce((total, amount) => total + microsOf(amount), 0)
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
