import { usdToMicros } from '@goblin/wallet/amounts'

const USD = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?$/u

/** What an allowance starts at before the owner changes it, in USDC per hour. */
export const DEFAULT_PER_HOUR = '20'

/** A positive USDC amount with at most six decimals: what `AllowancePrepare.perHour` takes. */
export const isPerHour = (value: string): boolean => USD.test(value) && usdToMicros(value) > 0n
