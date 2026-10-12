import type { McpServer } from '@modelcontextprotocol/server'
import { SwapQuoteInput, TOOLS } from '@goblin/wallet/contract'
import { freezeQuote } from '../../services/programs/plans.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerSwapQuote(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.swapQuote,
    {
      title: 'Swap quote',
      description:
        'Quote a swap. The quote is frozen for a few minutes: swap_execute pays exactly its terms, never new ones. Spends nothing.',
      inputSchema: standard(SwapQuoteInput),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const result = await box.run(freezeQuote('swap', (port) => port.swapQuote(input)))
      if (!result.ok) return refusal(result.failure)
      return answer(`${result.value.summary} Quote ${result.value.quote_id} expires ${result.value.expiresAt}.`, {
        quote: result.value,
      })
    },
  )
}
