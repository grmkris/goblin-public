import type { Ctx } from './rows.ts'
import { getState, putState } from './state.ts'

/**
 * The owner's on-chain allowances, as JSON the delegation code reads back: a prepared draft waits for the owner's
 * signature under its delegation hash, and the signed allowance of a chain replaces that chain's earlier one. They are
 * the authority the agent redeems from, so they live in the ledger, never in the App's view state.
 */
const PREPARED = 'allowance:prepared:'
const SIGNED = 'allowance:signed:'

export const putPreparedAllowance = (ctx: Ctx, hash: string, json: string): void =>
  putState(ctx, `${PREPARED}${hash.toLowerCase()}`, json)

export const preparedAllowance = (ctx: Ctx, hash: string): string | undefined =>
  getState(ctx, `${PREPARED}${hash.toLowerCase()}`)

export const putSignedAllowance = (ctx: Ctx, chain: string, json: string): void =>
  putState(ctx, `${SIGNED}${chain}`, json)

export const signedAllowances = (ctx: Ctx): { chain: string; json: string }[] =>
  ctx.sql
    .all<{ key: string; value: string }>('SELECT key, value FROM state WHERE key LIKE ? ORDER BY key', `${SIGNED}%`)
    .map((row) => ({ chain: row.key.slice(SIGNED.length), json: row.value }))
