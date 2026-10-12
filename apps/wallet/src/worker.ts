import { CHAINS } from '@goblin/wallet/chains'
import type { WalletEnv } from './env.ts'

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

/** One Durable Object per owner: the wallet's ledger. Filled in by the ledger lane. */
export class WalletLedger implements DurableObject {
  fetch(): Response {
    return json({ error: { code: 'not_found', message: 'The ledger has no routes yet.' } }, 404)
  }
}

/** A singleton for OAuth state. Filled in by the MCP lane. */
export class WalletAuth implements DurableObject {
  fetch(): Response {
    return json({ error: { code: 'not_found', message: 'The auth store has no routes yet.' } }, 404)
  }
}

export default {
  async fetch(request: Request, env: WalletEnv): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/health') {
      // Mainnets only when the owner flipped WALLET_LIVE; otherwise testnets.
      const live = env.WALLET_LIVE === '1'
      return json({
        ok: true,
        live,
        chains: CHAINS.filter((chain) => chain.testnet !== live).map((chain) => chain.caip2),
      })
    }
    if (request.method === 'GET' && pathname === '/api/config') return json({ privyAppId: env.PRIVY_APP_ID })
    return json({ error: { code: 'not_found', message: 'No such route.' } }, 404)
  },
} satisfies ExportedHandler<WalletEnv>
