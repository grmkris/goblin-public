import type { RailsPort } from '../services/rails.ts'
import type { RailsDeps } from './deps.ts'
import { bridgeExecute, bridgeQuote, swapExecute, swapQuote } from './exchange.ts'
import { payPaidFetch, quotePaidFetch } from './fetch.ts'
import { quoteTransfer, transfer } from './transfer.ts'
import { upgrade } from './upgrade.ts'
import { allowances, balances } from './views.ts'

export type { RailsDeps, RailsProfile, StoredAllowance } from './deps.ts'
export { RailError } from './deps.ts'

/** The payment rails the spend program calls: x402 and MPP fetches, transfers, swaps, bridges, balances, the relay. */
export const createRails = (deps: RailsDeps): RailsPort => ({
  quotePaidFetch: (service, args, rail) => quotePaidFetch(service, args, deps, rail),
  payPaidFetch: (operation, service, args) => payPaidFetch(operation, service, args, deps),
  quoteTransfer: (input) => quoteTransfer(input, deps),
  transfer: (operation) => transfer(operation, deps),
  swapQuote: (input) => swapQuote(input, deps),
  swapExecute: (operation, payload) => swapExecute(operation, payload, deps),
  bridgeQuote: (input) => bridgeQuote(input, deps),
  bridgeExecute: (operation, payload) => bridgeExecute(operation, payload, deps),
  balances: () => balances(deps),
  allowances: () => allowances(deps),
  upgrade: (request) => upgrade(request, deps),
})
