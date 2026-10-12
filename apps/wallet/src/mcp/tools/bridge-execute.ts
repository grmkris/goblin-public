import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { ExecuteQuoteInput, TOOLS } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { executeQuotePlan } from '../../services/programs/plans.ts'
import { runSpend } from '../../services/programs/spend.ts'
import { receiptMeta } from '../apps.ts'
import { handleSpend } from '../spend-reply.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

export function registerBridgeExecute(server: McpServer, box: Toolbox): void {
  registerAppTool(
    server,
    TOOLS.bridgeExecute,
    {
      title: 'Execute a bridge quote',
      description:
        'Pay a frozen bridge quote by its quote_id. Pass max_usd (decimal string) and a stable operation_id; retrying with the same id never pays twice. A spend over a limit waits for the owner.',
      inputSchema: standard(ExecuteQuoteInput),
      _meta: receiptMeta,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    (input, ctx) =>
      handleSpend(
        box,
        ctx,
        Effect.gen(function* () {
          return yield* runSpend(yield* executeQuotePlan('bridge', input, box.client))
        }),
      ),
  )
}
