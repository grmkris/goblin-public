import { microsToUsd, usdToMicros } from '@goblin/wallet/amounts'
import { DEFAULT_GRANT_DAYS, DEFAULT_LIMITS, type LimitView, type WalletLimits } from '@goblin/wallet/contract'
import { type Ctx, COUNTED_SQL, isoOf } from './rows.ts'

export const HOUR_MS = 3_600_000
export const WEEK_MS = 7 * 24 * HOUR_MS
const DAY_MS = 24 * HOUR_MS

interface LimitsRow {
  version: number
  per_call_micros: number
  per_hour_micros: number
  per_week_micros: number
  expires_at_ms: number
}

/** The limits in micro-dollars, as the reservation arithmetic uses them. */
export interface LimitsMicros {
  version: number
  perCall: bigint
  perHour: bigint
  perWeek: bigint
  expiresAtMs: number
}

export function currentLimits(ctx: Ctx): LimitsMicros {
  const row = ctx.sql.all<LimitsRow>('SELECT * FROM limits ORDER BY version DESC LIMIT 1')[0]
  if (row !== undefined) return fromRow(row)
  // First use: the defaults, expiring after the default grant period.
  const expiresAtMs = ctx.now() + DEFAULT_GRANT_DAYS * DAY_MS
  insertLimits(ctx, 1, {
    perCall: usdToMicros(DEFAULT_LIMITS.perCall),
    perHour: usdToMicros(DEFAULT_LIMITS.perHour),
    perWeek: usdToMicros(DEFAULT_LIMITS.perWeek),
    expiresAtMs,
  })
  return currentLimits(ctx)
}

const fromRow = (row: LimitsRow): LimitsMicros => ({
  version: row.version,
  perCall: BigInt(row.per_call_micros),
  perHour: BigInt(row.per_hour_micros),
  perWeek: BigInt(row.per_week_micros),
  expiresAtMs: row.expires_at_ms,
})

function insertLimits(
  ctx: Ctx,
  version: number,
  v: { perCall: bigint; perHour: bigint; perWeek: bigint; expiresAtMs: number },
): void {
  ctx.sql.run(
    'INSERT INTO limits (version, per_call_micros, per_hour_micros, per_week_micros, expires_at_ms, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    version,
    Number(v.perCall),
    Number(v.perHour),
    Number(v.perWeek),
    v.expiresAtMs,
    ctx.now(),
  )
}

export function toWalletLimits(limits: LimitsMicros): WalletLimits {
  return {
    perCall: microsToUsd(limits.perCall),
    perHour: microsToUsd(limits.perHour),
    perWeek: microsToUsd(limits.perWeek),
    expiresAt: isoOf(limits.expiresAtMs),
    version: limits.version,
  }
}

/** Writes a new limits version. Returns undefined when `expiresAt` is not a date or a limit is inconsistent. */
export function writeLimits(ctx: Ctx, input: Omit<WalletLimits, 'version'>): WalletLimits | undefined {
  const expiresAtMs = Date.parse(input.expiresAt)
  const perCall = usdToMicros(input.perCall)
  const perHour = usdToMicros(input.perHour)
  const perWeek = usdToMicros(input.perWeek)
  if (Number.isNaN(expiresAtMs)) return undefined
  if (perCall > perHour || perHour > perWeek) return undefined
  const version = currentLimits(ctx).version + 1
  insertLimits(ctx, version, { perCall, perHour, perWeek, expiresAtMs })
  return toWalletLimits(currentLimits(ctx))
}

export interface Window {
  usedMicros: bigint
  /** When the oldest counted reservation leaves the window; undefined when nothing is counted. */
  endsAtMs: number | undefined
}

/** The sum of counted reservations made within `windowMs` of now, and when the window next frees up. */
export function windowUsage(ctx: Ctx, windowMs: number): Window {
  const since = ctx.now() - windowMs
  const row = ctx.sql.all<{ total: number | null; oldest: number | null }>(
    `SELECT SUM(micros) AS total, MIN(reserved_at_ms) AS oldest FROM operations
     WHERE reserved_at_ms IS NOT NULL AND reserved_at_ms > ? AND status IN (${COUNTED_SQL})`,
    since,
  )[0]
  return {
    usedMicros: BigInt(row?.total ?? 0),
    endsAtMs: row?.oldest == null ? undefined : row.oldest + windowMs,
  }
}

const LEDGER_ENFORCER = 'This wallet ledger'

function periodView(period: 'hour' | 'week', limit: bigint, window: Window, now: number): LimitView {
  const remaining = limit > window.usedMicros ? limit - window.usedMicros : 0n
  const windowMs = period === 'hour' ? HOUR_MS : WEEK_MS
  return {
    layer: 'ledger',
    period,
    limit: microsToUsd(limit),
    used: microsToUsd(window.usedMicros),
    remaining: microsToUsd(remaining),
    enforcedBy: `${LEDGER_ENFORCER}, rolling ${period}`,
    periodEndsAt: isoOf(window.endsAtMs ?? now + windowMs),
  }
}

const callView = (limit: bigint): LimitView => ({
  layer: 'ledger',
  period: 'call',
  limit: microsToUsd(limit),
  enforcedBy: `${LEDGER_ENFORCER}, per call`,
})

/** The ledger layer's limits as the owner and the model see them. */
export function ledgerLimitViews(ctx: Ctx): LimitView[] {
  const limits = currentLimits(ctx)
  const now = ctx.now()
  return [
    callView(limits.perCall),
    periodView('hour', limits.perHour, windowUsage(ctx, HOUR_MS), now),
    periodView('week', limits.perWeek, windowUsage(ctx, WEEK_MS), now),
    {
      layer: 'ledger',
      period: 'total',
      limit: microsToUsd(limits.perWeek),
      enforcedBy: `${LEDGER_ENFORCER}, grant expires`,
      periodEndsAt: isoOf(limits.expiresAtMs),
    },
  ]
}

/** The limit views one spend of `micros` would cross. Empty when it fits. */
export function crossedLimits(ctx: Ctx, micros: bigint): LimitView[] {
  const limits = currentLimits(ctx)
  const now = ctx.now()
  const hour = windowUsage(ctx, HOUR_MS)
  const week = windowUsage(ctx, WEEK_MS)
  const crossed: LimitView[] = []
  if (micros > limits.perCall) crossed.push(callView(limits.perCall))
  if (hour.usedMicros + micros > limits.perHour) crossed.push(periodView('hour', limits.perHour, hour, now))
  if (week.usedMicros + micros > limits.perWeek) crossed.push(periodView('week', limits.perWeek, week, now))
  return crossed
}
