import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS, type WalletStatusResult } from '@goblin/wallet/contract'
import * as Schema from 'effect/Schema'
import { readStatus } from '../../services/programs/status.ts'
import { dashboardMeta } from '../apps.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

const NoInput = Schema.Struct({})

const dashboardText = (result: WalletStatusResult): string =>
  `Wallet dashboard: paid ${result.status.paid}, funding ${result.status.funding}, ${result.limits.length} limits, ${result.recent?.length ?? 0} recent spends.`

async function open(box: Toolbox) {
  const result = await box.run(readStatus)
  return result.ok ? answer(dashboardText(result.value), { ...result.value }) : refusal(result.failure)
}

export function registerWalletOpen(server: McpServer, box: Toolbox): void {
  registerAppTool(
    server,
    TOOLS.open,
    {
      title: 'Open the wallet',
      description:
        'Open the wallet dashboard: balances per chain, every limit with the layer that enforces it, and recent spends. Also returns the same as text.',
      inputSchema: standard(NoInput),
      _meta: dashboardMeta,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => open(box),
  )
  // The same view as a global entrypoint a host can launch for the owner (visible to the app, not the model).
  registerAppTool(
    server,
    TOOLS.openGlobal,
    {
      title: 'Wallet',
      description: 'The wallet dashboard as an app entrypoint.',
      inputSchema: standard(NoInput),
      _meta: {
        ui: { resourceUri: dashboardMeta.ui.resourceUri, visibility: ['app'] },
        'openai/ui': { entrypoints: [{ type: 'global' }] },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => open(box),
  )
}
