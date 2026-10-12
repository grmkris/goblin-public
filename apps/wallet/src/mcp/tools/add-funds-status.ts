import type { McpServer } from '@modelcontextprotocol/server'
import { AddFundsStatusInput, TOOLS, type DepositStatus } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Rails } from '../../services/rails.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

const STATES: Readonly<Record<DepositStatus['status'], string>> = {
  waiting: 'nothing has arrived at it yet',
  pending: 'Relay is filling it',
  success: 'filled; the funds have arrived',
  refunded: 'refunded to the sender side',
  failed: 'failed',
  unknown: 'Relay did not say just now; the balance shows the arrival (wallet_status)',
}

const readProgress = (depositAddress: string) =>
  Effect.gen(function* () {
    return yield* (yield* Rails).use((port) => port.depositProgress(depositAddress))
  })

export function registerAddFundsStatus(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.addFundsStatus,
    {
      title: 'Deposit progress',
      description: `Where a deposit address from ${TOOLS.addFunds} stands: waiting, pending, success, refunded, failed, or unknown when Relay does not say.`,
      inputSchema: standard(AddFundsStatusInput),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const result = await box.run(readProgress(input.deposit_address))
      if (!result.ok) return refusal(result.failure)
      const { status, txHashes } = result.value
      const hashes = txHashes.length === 0 ? '' : ` Transactions: ${txHashes.join(', ')}.`
      return answer(`Deposit ${input.deposit_address}: ${STATES[status]}.${hashes}`, { deposit: result.value })
    },
  )
}
