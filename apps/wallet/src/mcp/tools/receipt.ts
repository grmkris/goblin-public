import type { McpServer } from '@modelcontextprotocol/server'
import { OperationInput, TOOLS } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { failure } from '../../services/errors.ts'
import { readOperation } from '../../services/programs/operation.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'
import { describeOperation } from './operation.ts'

const receiptOf = (operationId: string) =>
  Effect.gen(function* () {
    const op = yield* readOperation(operationId)
    if (op.payment === undefined)
      return yield* failure('no_receipt', `Operation ${operationId} has no payment yet (${op.status}).`, 409)
    return op
  })

export function registerReceipt(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.receipt,
    {
      title: 'Receipt',
      description:
        'The receipt of a paid operation: what was paid, to whom, on which chain, with the transaction reference.',
      inputSchema: standard(OperationInput),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await box.run(receiptOf(input.operation_id))
      if (!result.ok) return refusal(result.failure)
      return answer(describeOperation(result.value), { operation: result.value })
    },
  )
}
