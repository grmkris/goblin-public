import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import { type Operation, PayChallengeInput, type PayChallengeResult, TOOLS } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { failure } from '../../services/errors.ts'
import { FUNDS_SHORT } from '../../rails/challenge.ts'
import { payChallenge, reportChallengeReceipt } from '../../services/programs/challenge.ts'
import { readLimits } from '../../services/programs/status.ts'
import { answer, refusal } from '../results.ts'
import { describeOperation, spendReply, spendScopeRefusal } from '../spend-reply.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

const DESCRIPTION = [
  "Signs an MPP charge for a request the caller makes itself; the wallet never fetches. Only goblin's runtime calls it.",
  'To pay: url and method of the request, challenge (the 402 WWW-Authenticate value, all of it; the Tempo USDC.e',
  'charge entry is used), max_usd and a stable operation_id. The url origin must be an allow-listed MPP payee and the',
  "challenge must pay that payee's recipient, unexpired. The answer's structuredContent.credential is the token after",
  '"Payment ": send the request again with `Authorization: Payment <credential>` within about 25 seconds. The same',
  'operation_id and arguments return the same credential and never sign again; the same challenge under another',
  'operation_id is refused. A spend over a limit waits for the owner (a URL request). The outcome stays unknown and',
  'the amount held until the service settles it: report its Payment-Receipt header value with the same operation_id',
  'and receipt alone; the wallet checks it on Tempo and marks the operation paid.',
].join(' ')

const PAY_FIELDS = ['url', 'method', 'challenge', 'max_usd'] as const

/** Why an operation the spend left without a credential has none, as the tool's refusal. */
const noCredential = (operation: Operation) => {
  if (operation.status === 'signing')
    return failure(
      'in_flight',
      `Operation ${operation.id} is being signed right now.`,
      409,
      'Call again with the same operation_id in a moment; never pay this challenge under another one.',
    )
  if (operation.status === 'uncertain')
    return failure(
      'outcome_unknown',
      `Operation ${operation.id} may have signed, but no credential was kept for it.`,
      409,
      'Never pay this challenge again; fetch a new one under a new operation_id.',
    )
  if (operation.status === 'failed' && operation.reason?.startsWith(FUNDS_SHORT) === true)
    return failure(
      'insufficient_funds',
      operation.reason,
      402,
      'Nothing was signed. Fund the agent wallet, then pay the challenge under a new operation_id.',
    )
  return failure(
    `payment_${operation.status}`,
    operation.reason ?? `Operation ${operation.id} is ${operation.status}.`,
    409,
  )
}

const pay = async (box: Toolbox, ctx: ServerContext, input: PayChallengeInput) => {
  const result = await box.run(
    Effect.gen(function* () {
      const paid = yield* payChallenge(input, box.client)
      return { ...paid, limits: yield* readLimits }
    }),
  )
  if (!result.ok) return refusal(result.failure)
  const { outcome, credential, limits } = result.value
  if (outcome.kind === 'awaiting_approval') return spendReply(outcome, limits, ctx, box)
  if (credential === undefined) return refusal(noCredential(outcome.operation))
  const structured: PayChallengeResult = { operation: outcome.operation, credential }
  const text = `${describeOperation(outcome.operation)}\nThe credential is in structuredContent.credential: send it as Authorization: Payment <credential>, then report the Payment-Receipt.`
  return answer(text, { ...structured, replay: outcome.replay })
}

const report = async (box: Toolbox, operationId: string, receipt: string) => {
  const result = await box.run(reportChallengeReceipt(operationId, receipt))
  if (!result.ok) return refusal(result.failure)
  const { operation, found } = result.value
  const structured: PayChallengeResult = { operation, found }
  const note = 'note' in result.value ? ` ${result.value.note}` : ''
  return answer(`${describeOperation(operation)}${found === 'paid' ? '' : note}`, { ...structured })
}

export function registerPayChallenge(server: McpServer, box: Toolbox): void {
  registerAppTool(
    server,
    TOOLS.payChallenge,
    {
      title: 'Pay an MPP challenge',
      description: DESCRIPTION,
      inputSchema: standard(PayChallengeInput),
      // Hidden from the model: goblin's runtime calls it from a dedicated caller, never from a turn.
      _meta: { ui: { visibility: ['app'] } },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (input, ctx) => {
      const refused = spendScopeRefusal(box)
      if (refused !== undefined) return refused
      if (input.receipt === undefined) return pay(box, ctx, input)
      if (PAY_FIELDS.some((field) => input[field] !== undefined))
        return refusal(failure('bad_request', 'Pass either the payment fields or a receipt, not both.', 400))
      return report(box, input.operation_id, input.receipt)
    },
  )
}
