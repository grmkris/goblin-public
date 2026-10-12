import type { McpServer } from '@modelcontextprotocol/server'
import { AddFundsInput, TOOLS, type DepositAddress } from '@goblin/wallet/contract'
import * as Effect from 'effect/Effect'
import { Rails } from '../../services/rails.ts'
import { answer, refusal } from '../results.ts'
import { standard } from '../standard.ts'
import type { Toolbox } from '../toolbox.ts'

const CHAIN_NAMES = { base: 'Base', arbitrum: 'Arbitrum', ethereum: 'Ethereum' } as const

/** Where the deposit lands, as the owner reads it. */
const landing = (quote: DepositAddress): string =>
  quote.receive === 'USDC.e'
    ? `the agent wallet ${quote.recipient} on Tempo, which pays paid inference and MPP services`
    : `the owner's account ${quote.recipient} on Base`

const quoteDeposit = (input: AddFundsInput) =>
  Effect.gen(function* () {
    return yield* (yield* Rails).use((port) => port.depositAddress(input))
  })

const depositText = (quote: DepositAddress): string =>
  `Send ${quote.amount} ${quote.asset} on ${CHAIN_NAMES[quote.from]} to ${quote.depositAddress}. About ${quote.expectedOut} ${quote.receive} arrives in ${landing(quote)}, usually within ${Math.max(quote.timeEstimateSeconds, 1)} s (Relay's fees $${quote.feesUsd}). The address serves this deposit only; follow it with ${TOOLS.addFundsStatus}.`

export function registerAddFunds(server: McpServer, box: Toolbox): void {
  server.registerTool(
    TOOLS.addFunds,
    {
      title: 'Add funds from any chain',
      description:
        "A one-off deposit address (Relay): send ETH or USDC to it on Base, Arbitrum or Ethereum and it arrives as USDC.e in the agent wallet on Tempo (the default, what paid inference and MPP services pay from), or as ETH or USDC in the owner's account on Base. Nothing is signed or spent; whoever sends pays.",
      inputSchema: standard(AddFundsInput),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => {
      const result = await box.run(quoteDeposit(input))
      return result.ok ? answer(depositText(result.value), { deposit: result.value }) : refusal(result.failure)
    },
  )
}
