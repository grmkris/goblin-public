// What the setup flow decides without the network: which screen to show for where the server says setup stands, the
// three confirmations that turn on spending and where each one is, and the limits said in words.
import { usdToMicros } from '@goblin/wallet/amounts'
import { DEFAULT_GRANT_DAYS, DEFAULT_LIMITS, type Me } from '@goblin/wallet/contract'
import { MAX_ALLOWANCE_DAYS } from '@goblin/wallet/delegation'
import { formatUsd } from '../../ui/format.ts'
import type { StepId } from '../progress.ts'
import { isPerHour } from '../per-hour.ts'

/** One task per screen: the agent wallet being made, adding funds, turning on spending, and the wallet ready. */
export type SetupScreen = 'agent' | 'fund' | 'spending' | 'done'

/**
 * The screen for where setup stands. Funding is its own screen until the owner presses Continue there (`holdFund`), so
 * USDC landing while they watch says so instead of the screen jumping away; on a fresh load an account that already
 * holds enough opens on turning on spending.
 */
export function screenOf(progress: StepId | 'done', holdFund: boolean): SetupScreen {
  if (progress === 'agent' || progress === 'fund') return progress
  if (progress === 'done') return 'done'
  return progress === 'upgrade' && holdFund ? 'fund' : 'spending'
}

/** "Step 1 of 2": the screens that are the owner's own tasks are numbered; the waits and the end are not. */
export function stepOf(screen: SetupScreen): number | undefined {
  if (screen === 'fund') return 1
  return screen === 'spending' ? 2 : undefined
}

/** Where turning on spending stands: idle, or which confirmation is being asked for. */
export type SpendingPhase = 'idle' | 'authorize' | 'confirm' | 'allowance'

export type ItemState = 'todo' | 'active' | 'failed' | 'done'

export interface SpendingItem {
  readonly id: Exclude<SpendingPhase, 'idle'>
  readonly label: string
  readonly state: ItemState
}

const ITEMS: readonly Omit<SpendingItem, 'state'>[] = [
  { id: 'authorize', label: 'Upgrade your account' },
  { id: 'confirm', label: 'Confirm the upgrade' },
  { id: 'allowance', label: 'Set your allowance' },
]

/**
 * The three confirmations and where each stands. What is done comes from the server (`upgraded`, `allowed`), so a
 * reload mid-way shows the same list; what is under way, or failed, comes from this page.
 */
export function spendingItems(input: {
  readonly upgraded: boolean
  readonly allowed: boolean
  readonly phase: SpendingPhase
  readonly failed: boolean
}): readonly SpendingItem[] {
  const order = ITEMS.map((item) => item.id)
  const at = input.phase === 'idle' ? -1 : order.indexOf(input.phase)
  return ITEMS.map((item, index) => {
    const done = item.id === 'allowance' ? input.allowed : input.upgraded || (at > index && at >= 0)
    if (done) return { ...item, state: 'done' }
    if (index === at) return { ...item, state: input.failed ? 'failed' : 'active' }
    return { ...item, state: 'todo' }
  })
}

/** How many times the owner still confirms in Privy: twice for the upgrade, once for the allowance. */
export const confirmationsLeft = (upgraded: boolean): number => (upgraded ? 1 : 3)

const COUNT = ['no times', 'once', 'twice', 'three times'] as const

/** "You'll confirm three times." */
export const confirmationsText = (upgraded: boolean): string =>
  `You'll confirm ${COUNT[confirmationsLeft(upgraded)] ?? `${confirmationsLeft(upgraded)} times`}.`

/** "$20" for a whole amount, "$0.50" otherwise: limits read as people say them. */
const usd = (amount: string): string => formatUsd(amount).replace(/\.00$/u, '')

/** What the owner chooses before turning on spending: the allowance per hour and for how many days. */
export interface SpendingChoice {
  readonly perHour: string
  readonly days: number
}

export const DEFAULT_CHOICE: SpendingChoice = { perHour: DEFAULT_LIMITS.perHour, days: DEFAULT_GRANT_DAYS }

/** A whole number of days the allowance can last, as the delegation takes it. */
export const isDays = (value: string): boolean =>
  /^[1-9]\d{0,2}$/u.test(value) && Number(value) >= 1 && Number(value) <= MAX_ALLOWANCE_DAYS

export const MAX_DAYS = MAX_ALLOWANCE_DAYS

/**
 * The limits in words: the allowance per hour the owner chose, and the wallet's own per-payment and weekly limits.
 * "Your agent may spend up to $20 an hour, $5 per payment and $50 a week, for 7 days."
 */
export function limitsSentence(choice: SpendingChoice, limits: Me['limits']): string {
  const perCall = limits?.perCall ?? DEFAULT_LIMITS.perCall
  const perWeek = limits?.perWeek ?? DEFAULT_LIMITS.perWeek
  const days = choice.days === 1 ? '1 day' : `${choice.days} days`
  return `Your agent may spend up to ${usd(choice.perHour)} an hour, ${usd(perCall)} per payment and ${usd(perWeek)} a week, for ${days}.`
}

/** The wallet's own hourly limit is lower than the allowance chosen: it still applies, and the page says so. */
export function hourlyCap(choice: SpendingChoice, limits: Me['limits']): string | undefined {
  if (limits === undefined || !isPerHour(choice.perHour)) return undefined
  return usdToMicros(limits.perHour) < usdToMicros(choice.perHour) ? usd(limits.perHour) : undefined
}

/** "Your agent can spend up to $20 an hour from your USDC on Base." once the allowance is signed. */
export function readySentence(me: Me): string {
  const allowance = me.chains.find((chain) => chain.chain === 'base')?.allowance
  return allowance === undefined
    ? 'Your agent can spend within the limits you set.'
    : `Your agent can spend up to ${usd(allowance.perHour)} an hour from your USDC on Base.`
}
