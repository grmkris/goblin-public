import type { RailsPort } from '../services/rails.ts'
import { check } from './check.ts'
import type { RailsDeps } from './deps.ts'
import { confirmChallenge, payChallenge } from './challenge.ts'
import { depositRails } from './deposit.ts'
import { bridgeExecute, bridgeQuote, swapExecute, swapQuote } from './exchange.ts'
import { payPaidFetch, quotePaidFetch } from './fetch.ts'
import { quoteTransfer, transfer } from './transfer.ts'
import { upgrade } from './upgrade.ts'
import { allowances, balances } from './views.ts'

export type { RailsDeps, StoredAllowance } from './deps.ts'

/**
 * The payment rails the spend program calls: x402 and MPP fetches, MPP challenges a caller fetched, transfers, swaps,
 * bridges, balances, the relay, and deposit addresses.
 */
export const createRails = (deps: RailsDeps): RailsPort => ({
  quotePaidFetch: (service, args, rail) => quotePaidFetch(service, args, deps, rail),
  payPaidFetch: (operation, service, args) => payPaidFetch(operation, service, args, deps),
  payChallenge: (operation, challenge, challengeId) => payChallenge(operation, challenge, challengeId, deps),
  confirmChallenge: (operation, challengeId, receipt) => confirmChallenge(operation, challengeId, receipt, deps),
  quoteTransfer: (input) => quoteTransfer(input, deps),
  transfer: (operation) => transfer(operation, deps),
  swapQuote: (input) => swapQuote(input, deps),
  swapExecute: (operation, payload) => swapExecute(operation, payload, deps),
  bridgeQuote: (input) => bridgeQuote(input, deps),
  bridgeExecute: (operation, payload) => bridgeExecute(operation, payload, deps),
  balances: () => balances(deps),
  allowances: () => allowances(deps),
  check: (operation) => check(operation, deps),
  upgrade: (request) => upgrade(request, deps),
  ...depositRails(deps),
})
