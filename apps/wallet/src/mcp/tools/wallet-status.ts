import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS } from '@goblin/wallet/contract'
import { readStatus } from '../../services/programs/status.ts'
import { answer, refusal } from '../results.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerWalletStatus(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.status,
    {
      title: 'Wallet status',
      description:
        'Is the wallet ready to pay, and how much can it spend now? Returns readiness, balances per chain, and every limit with the layer that enforces it.',
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = await box.run(readStatus)
      if (!result.ok) return refusal(result.failure)
      const { status, limits } = result.value
      const tokens = status.tokens.map(
        (t) => `${t.symbol} balance ${t.balance ?? '?'}, spendable ${t.spendable ?? '?'}`,
      )
      const text = [
        `Wallet: paid ${status.paid}, funding ${status.funding}.`,
        ...tokens,
        `${limits.length} limits are in force; ask for allowances to see each layer.`,
        status.expiresAt === undefined ? '' : `The grant expires ${status.expiresAt}.`,
      ]
        .filter((line) => line !== '')
        .join('\n')
      return answer(text, { ...result.value })
    },
  )
}
