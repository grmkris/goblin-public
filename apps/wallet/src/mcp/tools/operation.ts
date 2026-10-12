import type { McpServer } from '@modelcontextprotocol/server'
import { OperationInput, TOOLS, type Operation } from '@goblin/wallet/contract'
import { readOperation } from '../../services/programs/operation.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export const describeOperation = (op: Operation): string => {
  const paid = op.payment?.txHash === undefined ? '' : ` Transaction ${op.payment.txHash}.`
  const why = op.reason === undefined ? '' : ` ${op.reason}`
  return `${op.id}: ${op.status}. ${op.terms.kind} of $${op.terms.amountUsd} to ${op.terms.subject} on ${op.terms.chain}.${paid}${why}`
}

export function registerOperation(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.operation,
    {
      title: 'Operation status',
      description:
        'Where a spend stands, by the operation_id you gave it: quoted, awaiting_approval, reserved, submitted, confirmed, delivered, failed, uncertain, declined or expired.',
      inputSchema: standard(OperationInput),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const result = await box.run(readOperation(input.operation_id))
      if (!result.ok) return refusal(result.failure)
      return answer(describeOperation(result.value), { operation: result.value })
    },
  )
}
