import { CHAINS } from '@goblin/wallet/chains'
import type { WalletEnv } from './env.ts'
import { apiError, json } from './http.ts'

type Handler = (request: Request, env: WalletEnv) => Promise<Response>

/** The parts of the Worker that live in other modules. `oauth` answers undefined for a path that is not OAuth's. */
export interface Handlers {
  readonly oauth: (request: Request, env: WalletEnv) => Promise<Response | undefined>
  readonly api: Handler
  readonly mcp: Handler
}

const isOAuthPath = (pathname: string): boolean =>
  pathname.startsWith('/oauth/') || pathname.startsWith('/.well-known/') || pathname.startsWith('/api/oauth/')

const health = (env: WalletEnv): Response => {
  // Mainnets only when the owner flipped WALLET_LIVE; otherwise testnets.
  const live = env.WALLET_LIVE === '1'
  return json({ ok: true, live, chains: CHAINS.filter((chain) => chain.testnet !== live).map((chain) => chain.caip2) })
}

/**
 * The Worker's front door: /health, /api/config, OAuth, the owner API under /api/*, the MCP endpoint and the app views.
 * Everything else under the worker-first paths is a JSON 404; the SPA's own routes never reach this code.
 */
export function createRouter(handlers: Handlers): (request: Request, env: WalletEnv) => Promise<Response> {
  return async (request, env) => {
    const { pathname } = new URL(request.url)
    if (request.method === 'GET' && pathname === '/health') return health(env)
    if (request.method === 'GET' && pathname === '/api/config')
      return json({ privyAppId: env.PRIVY_APP_ID, stage: env.WALLET_LIVE === '1' ? 'mainnet' : 'testnet' })
    if (isOAuthPath(pathname)) {
      const answered = await handlers.oauth(request, env)
      if (answered !== undefined) return answered
    }
    if (pathname.startsWith('/api/')) return handlers.api(request, env)
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return handlers.mcp(request, env)
    if (request.method === 'GET' && pathname.startsWith('/views/')) return env.ASSETS.fetch(request)
    return apiError('not_found', 'No such route.', 404)
  }
}
