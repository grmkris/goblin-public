import type { ChainKey, Recipient } from '@goblin/wallet/contract'
import { type Ctx, isoOf } from './rows.ts'
import { getState, putState, VIEW_STATE_MAX_BYTES } from './state.ts'

interface BookRow {
  chain: ChainKey
  address: string
  label: string
  added_at_ms: number
}

const toRecipient = (row: BookRow): Recipient => ({
  address: row.address,
  chain: row.chain,
  label: row.label,
  addedAt: isoOf(row.added_at_ms),
})

export function recipients(ctx: Ctx): Recipient[] {
  return ctx.sql.all<BookRow>('SELECT * FROM address_book ORDER BY added_at_ms, address').map(toRecipient)
}

export function isKnownRecipient(ctx: Ctx, chain: ChainKey, address: string): boolean {
  return (
    ctx.sql.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM address_book WHERE chain = ? AND address = ?',
      chain,
      address.toLowerCase(),
    )[0]?.n === 1
  )
}

export function addRecipient(ctx: Ctx, chain: ChainKey, address: string, label: string): void {
  ctx.sql.run(
    'INSERT INTO address_book (chain, address, label, added_at_ms) VALUES (?, ?, ?, ?) ON CONFLICT(chain, address) DO NOTHING',
    chain,
    address.toLowerCase(),
    label,
    ctx.now(),
  )
}

/** Service ids the owner approved beyond the built-in defaults (`allowed`) or switched off (`!allowed`). */
export function serviceOverrides(ctx: Ctx): Map<string, boolean> {
  const rows = ctx.sql.all<{ id: string; allowed: number }>('SELECT id, allowed FROM service_overrides')
  return new Map(rows.map((row) => [row.id, row.allowed === 1]))
}

export function setServiceAllowed(ctx: Ctx, id: string, allowed: boolean): void {
  ctx.sql.run(
    `INSERT INTO service_overrides (id, allowed, updated_at_ms) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET allowed = excluded.allowed, updated_at_ms = excluded.updated_at_ms`,
    id,
    allowed ? 1 : 0,
    ctx.now(),
  )
}

export interface PolicyChange {
  id: string
  change: string
  reason: string
  client: string
  status: 'pending' | 'applied' | 'dismissed'
  createdAt: string
}

interface PolicyRow {
  id: string
  change_text: string
  reason: string
  client: string
  status: PolicyChange['status']
  created_at_ms: number
}

const toPolicy = (row: PolicyRow): PolicyChange => ({
  id: row.id,
  change: row.change_text,
  reason: row.reason,
  client: row.client,
  status: row.status,
  createdAt: isoOf(row.created_at_ms),
})

export function recordPolicyChange(ctx: Ctx, id: string, change: string, reason: string, client: string): PolicyChange {
  ctx.sql.run(
    `INSERT INTO policy_changes (id, change_text, reason, client, status, created_at_ms) VALUES (?, ?, ?, ?, 'pending', ?)
     ON CONFLICT(id) DO NOTHING`,
    id,
    change,
    reason,
    client,
    ctx.now(),
  )
  const row = ctx.sql.all<PolicyRow>('SELECT * FROM policy_changes WHERE id = ?', id)[0]
  if (row === undefined) throw new Error('policy change vanished inside a write')
  return toPolicy(row)
}

export function policyChanges(ctx: Ctx): PolicyChange[] {
  return ctx.sql.all<PolicyRow>('SELECT * FROM policy_changes ORDER BY created_at_ms DESC LIMIT 50').map(toPolicy)
}

export type PolicyDecision =
  | { readonly ok: true; readonly change: PolicyChange }
  | { readonly ok: false; readonly code: 'unknown_policy_change' | 'policy_change_closed' }

/** Moves a pending request to applied or dismissed; any other row is left as it is. */
export function decidePolicyChange(ctx: Ctx, id: string, status: 'applied' | 'dismissed'): PolicyDecision {
  const row = ctx.sql.all<PolicyRow>('SELECT * FROM policy_changes WHERE id = ?', id)[0]
  if (row === undefined) return { ok: false, code: 'unknown_policy_change' }
  if (row.status !== 'pending') return { ok: false, code: 'policy_change_closed' }
  ctx.sql.run("UPDATE policy_changes SET status = ? WHERE id = ? AND status = 'pending'", status, id)
  return { ok: true, change: toPolicy({ ...row, status }) }
}

/** The app's view state: bounded JSON text. Returns false when it is too large. */
export function writeViewState(ctx: Ctx, json: string): boolean {
  if (new TextEncoder().encode(json).length > VIEW_STATE_MAX_BYTES) return false
  putState(ctx, 'view_state', json)
  return true
}

export const readViewState = (ctx: Ctx): string => getState(ctx, 'view_state') ?? '{}'
