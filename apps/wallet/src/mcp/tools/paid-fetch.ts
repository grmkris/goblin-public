import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { PaidFetchInput, TOOLS } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { paidFetchPlan } from '../../services/programs/plans.ts'
import { runSpend } from '../../services/programs/spend.ts'
import { receiptMeta } from '../apps.ts'
import { handleSpend } from '../spend-reply.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerPaidFetch(server: McpServer, box: Toolbox): void {
  registerAppTool(
    server,
    TOOLS.paidFetch,
    {
      title: 'Pay for a service',
      description:
        'Call an allowed paid service and pay for it from the wallet. Pass the service id from services, its args, max_usd (the most you agree to pay, a decimal string) and a stable operation_id: retrying with the same operation_id never pays twice. A spend over a limit waits for the owner.',
      inputSchema: standard(PaidFetchInput),
      _meta: receiptMeta,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input, ctx) =>
      handleSpend(
        box,
        ctx,
        Effect.gen(function* () {
          return yield* runSpend(yield* paidFetchPlan(input, box.client))
        }),
      ),
  )
}
