import type { Ctx } from './rows.ts'
import { getState, putState } from './state.ts'

/**
 * The owner's account upgrades waiting for their signature: the prepared UserOperation, as JSON the upgrade rail reads
 * back, under its upgrade id. It is exactly what the Worker sends once the owner signed it, so it lives in the ledger,
 * never in the App's view state.
 */
const PREPARED = 'upgrade:prepared:'

export const putPreparedUpgrade = (ctx: Ctx, id: string, json: string): void => putState(ctx, `${PREPARED}${id}`, json)

export const preparedUpgrade = (ctx: Ctx, id: string): string | undefined => getState(ctx, `${PREPARED}${id}`)
