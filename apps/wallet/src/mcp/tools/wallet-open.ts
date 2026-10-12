import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import { TOOLS, WalletOpenInput, type WalletStatusResult } from '@goblin/wallet/contract'
import { readStatusWithSetup } from '../../services/programs/status.ts'
import { dashboardMeta } from '../apps.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

const dashboardText = (result: WalletStatusResult): string =>
  `Wallet dashboard: paid ${result.status.paid}, funding ${result.status.funding}, ${result.limits.length} limits, ${result.recent?.length ?? 0} recent spends.`

/**
 * The dashboard's data and what setup still needs (`setup`, empty once finished: the App shows a setup card while it
 * is not); `focus` opens the App on that part (Add funds, for an owner who must fund the agent first).
 */
async function open(box: Toolbox, input: WalletOpenInput) {
  const read = await box.run(readStatusWithSetup)
  if (!read.ok) return refusal(read.failure)
  const focus = input.focus === undefined ? {} : { focus: input.focus }
  return answer(dashboardText(read.value.result), { ...read.value.result, setup: read.value.setup, ...focus })
}

export function registerWalletOpen(server: McpServer, box: Toolbox): void {
  registerAppTool(
    server,
    TOOLS.open,
    {
      title: 'Open the wallet',
      description:
        'Open the wallet dashboard: balances per chain, every limit with the layer that enforces it, and recent spends. Also returns the same as text. focus "add_funds" opens it on Add funds: the agent\'s address and a deposit address from any chain.',
      inputSchema: standard(WalletOpenInput),
      _meta: dashboardMeta,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => open(box, input),
  )
  // The same view as a global entrypoint a host can launch for the owner (visible to the app, not the model).
  registerAppTool(
    server,
    TOOLS.openGlobal,
    {
      title: 'Wallet',
      description: 'The wallet dashboard as an app entrypoint; focus "add_funds" opens it on Add funds.',
      inputSchema: standard(WalletOpenInput),
      _meta: {
        ui: { resourceUri: dashboardMeta.ui.resourceUri, visibility: ['app'] },
        'openai/ui': { entrypoints: [{ type: 'global' }] },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => open(box, input),
  )
}
