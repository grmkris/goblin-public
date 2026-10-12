import { McpServer } from '@modelcontextprotocol/server'
import { registerViews } from './apps.ts'
import { registerViewState } from './tools/view-state.ts'
import { registerWalletOpen } from './tools/wallet-open.ts'
import { registerAllowances } from './tools/allowances.ts'
import { registerBalances } from './tools/balances.ts'
import { registerOperation } from './tools/operation.ts'
import { registerBridgeExecute } from './tools/bridge-execute.ts'
import { registerBridgeQuote } from './tools/bridge-quote.ts'
import { registerPaidFetch } from './tools/paid-fetch.ts'
import { registerPayChallenge } from './tools/pay-challenge.ts'
import { registerPolicyChange } from './tools/policy-change.ts'
import { registerSwapExecute } from './tools/swap-execute.ts'
import { registerSwapQuote } from './tools/swap-quote.ts'
import { registerTransfer } from './tools/transfer.ts'
import { registerReceipt } from './tools/receipt.ts'
import { registerServices } from './tools/services.ts'
import { registerWalletStatus } from './tools/wallet-status.ts'
import type { Toolbox } from './toolbox.ts'

const GUIDE =
  "Goblin Wallet is the owner's agent wallet. Every limit names the layer that enforces it. Paid tools take a stable operation_id: retrying with the same id never pays twice. A spend over a limit or to a new recipient waits for the owner's approval."

/** The wallet's MCP server for one request: the owner's tools bound to a toolbox. */
export function walletServer(box: Toolbox): McpServer {
  const server = new McpServer({ name: 'goblin-wallet', version: '0.1.0' }, { instructions: GUIDE })
  registerWalletStatus(server, box)
  registerBalances(server, box)
  registerAllowances(server, box)
  registerServices(server, box)
  registerOperation(server, box)
  registerReceipt(server, box)
  registerPaidFetch(server, box)
  registerPayChallenge(server, box)
  registerTransfer(server, box)
  registerSwapQuote(server, box)
  registerSwapExecute(server, box)
  registerBridgeQuote(server, box)
  registerBridgeExecute(server, box)
  registerPolicyChange(server, box)
  registerViews(server, box)
  registerWalletOpen(server, box)
  registerViewState(server, box)
  return server
}
