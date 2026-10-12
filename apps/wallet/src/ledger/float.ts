import { microsToUsd, usdToMicros } from '@goblin/wallet/amounts'
import type { Operation, Terms } from '@goblin/wallet/contract'
import { currentLimits } from './limits.ts'
import { requireRow } from './operations.ts'
import { type Ctx, isoOf, type OperationRow, toOperation } from './rows.ts'
import { getState, isRevoked, putState } from './state.ts'

/**
 * The Tempo float's refills (ADR 0051): the wallet's own moves of Base USDC to the agent's Tempo address. Each is an
 * operation in the activity, under an id of its own, but never a client's spend: it is not reserved, so the rolling
 * windows never count it (the Tempo payments it funds are counted when they are paid), and the on-chain allowance
 * bounds it. One refill is in flight at a time per owner.
 */
export const FLOAT_PREFIX = 'float:'
/** How long a refill holds the single flight after its last change; a bridge lands within a minute or two. */
export const FLOAT_LEASE_MS = 10 * 60_000
/** A failed refill is tried again after these delays; after the last one, refills pause for an hour. */
const RETRY_MS: readonly number[] = [60_000, 300_000]
const PAUSE_MS = 3_600_000
const MEMO_KEY = 'float'
/** Not finished: being sent, sent, unknown, or deposited with Relay's arrival still pending. */
const IN_FLIGHT = `(status IN ('signing', 'submitted', 'uncertain')
  OR (status = 'confirmed' AND json_extract(delivery_json, '$.status') = 'pending'))`

interface Memo {
  /** The largest payment a trigger asked to fit since the last run, in micro-dollars. */
  readonly needMicros?: number
  readonly failures: number
  readonly pausedUntilMs?: number
}

const readMemo = (ctx: Ctx): Memo => {
  const raw = getState(ctx, MEMO_KEY)
  // SAFETY: only writeMemo below writes this key, with JSON.stringify of a Memo.
  return raw === undefined ? { failures: 0 } : (JSON.parse(raw) as Memo)
}

const writeMemo = (ctx: Ctx, memo: Memo): void => putState(ctx, MEMO_KEY, JSON.stringify(memo))

/** The latest refill still holding the flight: not finished, and changed within the lease. */
const inFlightRow = (ctx: Ctx): OperationRow | undefined =>
  ctx.sql.all<OperationRow>(
    `SELECT * FROM operations WHERE id LIKE '${FLOAT_PREFIX}%' AND ${IN_FLIGHT} AND updated_at_ms > ?
     ORDER BY created_at_ms DESC LIMIT 1`,
    ctx.now() - FLOAT_LEASE_MS,
  )[0]

export interface FloatState {
  /** A refill is in flight: claimed, not finished, within its lease. */
  readonly refilling: boolean
  readonly operation?: Operation
  /** Refills pause until then after repeated failures. */
  readonly pausedUntil?: string
}

export function floatState(ctx: Ctx): FloatState {
  const row = inFlightRow(ctx)
  const { pausedUntilMs } = readMemo(ctx)
  return {
    refilling: row !== undefined,
    ...(row === undefined ? {} : { operation: toOperation(row) }),
    ...(pausedUntilMs === undefined || pausedUntilMs <= ctx.now() ? {} : { pausedUntil: isoOf(pausedUntilMs) }),
  }
}

/** A trigger's payment that the next run must fit (a decimal USD amount); the largest since the last run is kept. */
export function noteFloatNeed(ctx: Ctx, need: string): void {
  ctx.sql.atomic(() => {
    const memo = readMemo(ctx)
    const micros = Number(usdToMicros(need))
    writeMemo(ctx, { ...memo, needMicros: Math.max(memo.needMicros ?? 0, micros) })
  })
}

export interface FloatRunStart {
  /** The payment to fit, taken from the memo (a decimal USD amount). */
  readonly need?: string
  readonly paused: boolean
  readonly inFlight?: Operation
}

/** A run begins: it takes the noted need, and learns whether refills are paused or one is already in flight. */
export function startFloatRun(ctx: Ctx): FloatRunStart {
  return ctx.sql.atomic((): FloatRunStart => {
    const { needMicros, ...memo } = readMemo(ctx)
    writeMemo(ctx, memo)
    const row = inFlightRow(ctx)
    return {
      ...(needMicros === undefined ? {} : { need: microsToUsd(BigInt(needMicros)) }),
      paused: memo.pausedUntilMs !== undefined && memo.pausedUntilMs > ctx.now(),
      ...(row === undefined ? {} : { inFlight: toOperation(row) }),
    }
  })
}

export type FloatClaim =
  | { readonly kind: 'claimed' | 'in_flight'; readonly operation: Operation }
  | { readonly kind: 'refused'; readonly reason: string }

/** A refill that lost its run (the Durable Object reset mid-flight) is unknown, never retried as if unsent. */
const releaseStale = (ctx: Ctx): void => {
  ctx.sql.run(
    `UPDATE operations SET status = 'uncertain', reason = 'The refill did not finish; its outcome is unknown.',
     updated_at_ms = ? WHERE id LIKE '${FLOAT_PREFIX}%' AND status IN ('signing', 'submitted') AND updated_at_ms <= ?`,
    ctx.now(),
    ctx.now() - FLOAT_LEASE_MS,
  )
}

/**
 * Claims the flight for one refill, in one transaction: refused when the wallet is revoked or its grant expired; the
 * refill already in flight when there is one; otherwise a new `signing` operation that is never reserved.
 */
export function claimFloat(ctx: Ctx, input: { terms: Terms; termsHash: string }): FloatClaim {
  return ctx.sql.atomic((): FloatClaim => {
    if (isRevoked(ctx)) return { kind: 'refused', reason: 'The owner revoked this wallet.' }
    const limits = currentLimits(ctx)
    if (limits.expiresAtMs <= ctx.now()) return { kind: 'refused', reason: 'The wallet grant expired.' }
    const flying = inFlightRow(ctx)
    if (flying !== undefined) return { kind: 'in_flight', operation: toOperation(flying) }
    releaseStale(ctx)
    const now = ctx.now()
    const count = ctx.sql.all<{ n: number }>(`SELECT COUNT(*) AS n FROM operations WHERE id LIKE '${FLOAT_PREFIX}%'`)
    const id = `${FLOAT_PREFIX}${now}:${(count[0]?.n ?? 0) + 1}`
    ctx.sql.run(
      `INSERT INTO operations (id, kind, status, terms_json, terms_hash, args_hash, micros, limits_version,
        recipient, client, created_at_ms, updated_at_ms) VALUES (?, ?, 'signing', ?, ?, 'float', ?, ?, ?, ?, ?, ?)`,
      id,
      input.terms.kind,
      JSON.stringify(input.terms),
      input.termsHash,
      Number(usdToMicros(input.terms.amountUsd)),
      limits.version,
      input.terms.recipient.toLowerCase(),
      'Goblin Wallet',
      now,
      now,
    )
    return { kind: 'claimed', operation: toOperation(requireRow(ctx, id)) }
  })
}

/**
 * A run ends. A refill that went out clears the failures; one that failed is tried again later (`retryInMs`), and
 * after the last retry refills pause for an hour.
 */
export function endFloatRun(ctx: Ctx, result: 'sent' | 'failed' | 'idle'): { retryInMs?: number } {
  return ctx.sql.atomic(() => {
    const memo = readMemo(ctx)
    if (result === 'idle') return {}
    if (result === 'sent') {
      writeMemo(ctx, { ...(memo.needMicros === undefined ? {} : { needMicros: memo.needMicros }), failures: 0 })
      return {}
    }
    const failures = memo.failures + 1
    const retryInMs = RETRY_MS[failures - 1]
    if (retryInMs !== undefined) {
      writeMemo(ctx, { ...memo, failures })
      return { retryInMs }
    }
    writeMemo(ctx, { ...memo, failures: 0, pausedUntilMs: ctx.now() + PAUSE_MS })
    return {}
  })
}
