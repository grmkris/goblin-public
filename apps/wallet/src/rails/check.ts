// Checks an operation whose outcome is unknown against the chain: its transaction's receipt, or for x402 whether its
// EIP-3009 authorization was used. One read each; a check never signs, sends or retries a payment.
import { authorizationUsed, transactionFate } from '@goblin/wallet/balances'
import type { Operation } from '@goblin/wallet/contract'
import type { CheckFinding } from '../services/rails.ts'
import type { RailsDeps } from './deps.ts'

const settledNow = (operation: Operation, deps: RailsDeps) => ({
  ...operation.payment,
  rail: operation.payment?.rail ?? operation.terms.rail,
  settledAt: (deps.now ?? (() => new Date()))().toISOString(),
})

/** A sent transaction: mined is paid (a bridge's arrival stays unknown), reverted is not, missing is not known yet. */
const byTransaction = async (operation: Operation, hash: string, deps: RailsDeps): Promise<CheckFinding> => {
  const fate = await transactionFate(deps.rpcFor(operation.terms.chain), hash)
  if (fate === 'success')
    return { found: 'paid', payment: settledNow(operation, deps), delivered: operation.terms.kind !== 'bridge' }
  if (fate === 'reverted') return { found: 'not_paid', reason: 'The chain rejected the transaction; nothing was paid.' }
  return { found: 'unknown', reason: 'The transaction is not on chain yet. Check again in a few minutes.' }
}

/** An x402 authorization: used is paid, unused past its deadline can never be, unused before it still could be. */
const byAuthorization = async (
  operation: Operation,
  authorization: NonNullable<NonNullable<Operation['payment']>['authorization']>,
  deps: RailsDeps,
): Promise<CheckFinding> => {
  const used = await authorizationUsed(deps.rpcFor(operation.terms.chain), operation.terms.token.address, authorization)
  if (used) return { found: 'paid', payment: settledNow(operation, deps), delivered: false }
  const deadline = Number(authorization.validBefore) * 1000
  const now = (deps.now ?? (() => new Date()))().getTime()
  if (now > deadline)
    return { found: 'not_paid', reason: 'The payment authorization expired unused; nothing was paid.' }
  const minutes = Math.max(1, Math.ceil((deadline - now) / 60_000))
  return {
    found: 'unknown',
    reason: `The authorization is unused but could still settle for another ${minutes} min. Check again after that.`,
  }
}

export const check = async (operation: Operation, deps: RailsDeps): Promise<CheckFinding> => {
  const payment = operation.payment
  if (payment?.txHash !== undefined) return byTransaction(operation, payment.txHash, deps)
  if (payment?.authorization !== undefined) return byAuthorization(operation, payment.authorization, deps)
  return { found: 'unknown', reason: 'Nothing was recorded that the chain could be asked about.' }
}
