import { RESOURCE_MIME_TYPE, registerAppResource } from '@modelcontextprotocol/ext-apps/server'
import type { McpServer } from '@modelcontextprotocol/server'
import type { Toolbox } from './toolbox.ts'

/** The two MCP App views, built by the web app and served from the assets binding. */
export const DASHBOARD_URI = 'ui://goblin-wallet/dashboard'
export const RECEIPT_URI = 'ui://goblin-wallet/receipt'

/** Tool metadata that attaches a view to a tool's result. */
export const dashboardMeta = { ui: { resourceUri: DASHBOARD_URI } }
export const receiptMeta = { ui: { resourceUri: RECEIPT_URI } }

const VIEWS = [
  {
    name: 'Wallet dashboard',
    uri: DASHBOARD_URI,
    file: 'dashboard',
    description: 'Balances, limits by layer and recent spends.',
  },
  {
    name: 'Spend receipt',
    uri: RECEIPT_URI,
    file: 'receipt',
    description: 'What a spend paid, and whether it was delivered.',
  },
] as const

/** Serves each view as `text/html;profile=mcp-app` from the assets binding. */
export function registerViews(server: McpServer, box: Toolbox): void {
  for (const view of VIEWS) {
    registerAppResource(
      server,
      view.name,
      view.uri,
      { description: view.description, mimeType: RESOURCE_MIME_TYPE },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: await box.readView(view.file) }],
      }),
    )
  }
}
