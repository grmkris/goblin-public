import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS, TransferInput } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { transferPlan } from '../../services/programs/plans.ts'
import { runSpend } from '../../services/programs/spend.ts'
import { handleSpend } from '../spend-reply.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerTransfer(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.transfer,
    {
      title: 'Transfer',
      description:
        'Send a token from the wallet to an address. The first payment to a new recipient waits for the owner. Pass max_usd (decimal string) and a stable operation_id; retrying with the same id never sends twice.',
      inputSchema: standard(TransferInput),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input, ctx) =>
      handleSpend(
        box,
        ctx,
        Effect.gen(function* () {
          return yield* runSpend(yield* transferPlan(input, box.client))
        }),
      ),
  )
}
