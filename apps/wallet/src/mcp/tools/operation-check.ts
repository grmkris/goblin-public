import type { McpServer } from '@modelcontextprotocol/server'
import { OperationInput, TOOLS } from '@goblin/wallet/contract'
import { checkOperation } from '../../services/programs/check.ts'
import { answer, refusal } from '../results.ts'
import { describeOperation } from '../spend-reply.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerOperationCheck(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.operationCheck,
    {
      title: 'Check an operation',
      description:
        "Checks a spend whose outcome is uncertain against the chain (its transaction, or its x402 authorization) and records what it finds: paid, not paid (its hold is released) or still unknown. It never pays; don't spend again for the same thing while it is uncertain.",
      inputSchema: standard(OperationInput),
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const result = await box.run(checkOperation(input.operation_id))
      if (!result.ok) return refusal(result.failure)
      const { operation, note } = result.value
      return answer(`${note} ${describeOperation(operation)}`.slice(0, 1000), { ...result.value })
    },
  )
}
