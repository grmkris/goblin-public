import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Rails } from '../../services/rails.ts'
import { answer, refusal } from '../results.ts'
import type { Toolbox } from '../toolbox.ts'

const readBalances = Effect.gen(function* () {
  return yield* (yield* Rails).use((port) => port.balances())
})

export function registerBalances(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.balances,
    {
      title: 'Balances',
      description:
        "The wallet's token balances, unified and broken down per chain and holder (the owner's account or the agent's own wallet).",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const result = await box.run(readBalances)
      if (!result.ok) return refusal(result.failure)
      const lines = result.value.map((b) => `${b.symbol} on ${b.chain}: ${b.balance} (${b.holder})`)
      return answer(lines.length === 0 ? 'No balances.' : lines.join('\n'), { balances: result.value })
    },
  )
}
