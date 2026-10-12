import { type LimitView, type Operation, type SpendResult } from '@goblin/wallet/contract'
import { inputRequired, type ServerContext } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import type { WalletFailure } from '../services/errors.ts'
import type { WalletServices } from '../services/index.ts'
import { readLimits } from '../services/programs/status.ts'
import type { SpendOutcome } from '../services/programs/spend.ts'
import { answer, refusal } from './results.ts'
import type { Toolbox } from './toolbox.ts'

/** The one input request of an approval: the link the owner opens. */
const APPROVAL = 'approval'
const BODY_TEXT_MAX = 4000

export const describeOperation = (op: Operation): string => {
  const paid = op.payment?.txHash === undefined ? '' : ` Transaction ${op.payment.txHash}.`
  const why = op.reason === undefined ? '' : ` ${op.reason}`
  return `${op.id}: ${op.status}. ${op.terms.kind} of $${op.terms.amountUsd} to ${op.terms.subject} on ${op.terms.chain}.${paid}${why}`
}

const bodyText = (body: unknown): string => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return text.length > BODY_TEXT_MAX ? `${text.slice(0, BODY_TEXT_MAX)}…` : text
}

const doneReply = (outcome: Extract<SpendOutcome, { kind: 'done' }>, limits: readonly LimitView[]) => {
  const { operation, response } = outcome
  const lines = [
    describeOperation(operation),
    outcome.replay ? 'This operation_id was already used; nothing more was spent.' : '',
    response === undefined
      ? ''
      : `Response ${response.status} (${response.contentType})${response.truncated ? ', truncated' : ''}: ${bodyText(response.body)}`,
  ].filter((line) => line !== '')
  const structured: SpendResult = { operation, ...(response === undefined ? {} : { response }), limits }
  return answer(lines.join('\n'), { ...structured, replay: outcome.replay })
}

const waitingText = (outcome: Extract<SpendOutcome, { kind: 'awaiting_approval' }>): string =>
  `This $${outcome.operation.terms.amountUsd} spend to ${outcome.operation.terms.subject} waits for the owner (${outcome.approval.reason.replaceAll('_', ' ')}). ` +
  `Open ${outcome.url} to approve it, then call this tool again with the same operation_id.`

/**
 * What a spend answers with. A spend waiting for the owner asks a modern client to open the approval link (URL
 * elicitation, retried with the same operation_id); an older client is told in the result. Dismissing the link ends
 * the call without touching the approval, which still waits.
 */
export function spendReply(outcome: SpendOutcome, limits: readonly LimitView[], ctx: ServerContext, box: Toolbox) {
  if (outcome.kind === 'done') return doneReply(outcome, limits)
  const text = waitingText(outcome)
  const structured: SpendResult & { approval: { url: string; reason: string; expiresAt: string } } = {
    operation: outcome.operation,
    approveUrl: outcome.url,
    limits,
    approval: { url: outcome.url, reason: outcome.approval.reason, expiresAt: outcome.approval.expiresAt },
  }
  const dismissed = ctx.mcpReq.inputResponses?.[APPROVAL]
  const action =
    typeof dismissed === 'object' && dismissed !== null && 'action' in dismissed ? dismissed.action : undefined
  if (box.era === 'modern' && action !== 'decline' && action !== 'cancel')
    return inputRequired({
      inputRequests: { [APPROVAL]: inputRequired.elicitUrl({ message: text, url: outcome.url }) },
      requestState: outcome.operation.id,
    })
  return answer(text, structured)
}

/** Runs a spend program and turns its outcome, or its refusal, into the tool's result. */
export async function handleSpend(
  box: Toolbox,
  ctx: ServerContext,
  program: Effect.Effect<SpendOutcome, WalletFailure, WalletServices>,
) {
  const result = await box.run(
    Effect.gen(function* () {
      const outcome = yield* program
      return { outcome, limits: yield* readLimits }
    }),
  )
  return result.ok ? spendReply(result.value.outcome, result.value.limits, ctx, box) : refusal(result.failure)
}
