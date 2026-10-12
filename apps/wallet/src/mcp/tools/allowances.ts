import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS } from '@goblin/wallet/contract'
import { readLimits } from '../../services/programs/status.ts'
import { answer, refusal } from '../results.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerAllowances(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.allowances,
    {
      title: 'Allowances and limits',
      description:
        'Every limit on what the agent may spend, each labelled with the layer that enforces it (onchain, tempo, signer, ledger, client) and what is left.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = await box.run(readLimits)
      if (!result.ok) return refusal(result.failure)
      const lines = result.value.map(
        (l) =>
          `[${l.layer}] ${l.period}${l.chain === undefined ? '' : ` on ${l.chain}`}: limit $${l.limit}` +
          `${l.remaining === undefined ? '' : `, $${l.remaining} left`} (${l.enforcedBy})`,
      )
      return answer(lines.join('\n'), { limits: result.value })
    },
  )
}
