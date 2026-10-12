import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { type Owner, partsFor, type Wiring } from '../context.ts'
import type { WalletEnv } from '../env.ts'
import { runWallet } from '../runtime.ts'
import { walletLayer } from '../services/index.ts'
import type { McpAuthenticator } from './auth.ts'
import { walletServer } from './server.ts'

async function readView(env: WalletEnv, origin: string, name: string): Promise<string> {
  // The assets binding serves `views/<name>.html` at `/views/<name>` and answers the `.html` path with a 307.
  const response = await env.ASSETS.fetch(new Request(`${origin}/views/${name}`))
  if (!response.ok) throw new Error(`view ${name} is not built: ${response.status}`)
  return response.text()
}

export interface McpDeps {
  readonly authenticate: McpAuthenticator
  readonly wiring: Wiring
}

/**
 * `/mcp`: validate Host and Origin, verify the bearer token, then serve a stateless MCP handler bound to that owner's
 * ledger, signer and rails. The canonical host is the request's own: a browser page on another origin is refused.
 */
export function createMcpEndpoint(deps: McpDeps): (request: Request, env: WalletEnv) => Promise<Response> {
  return async (request, env) => {
    const url = new URL(request.url)
    const rejected =
      hostHeaderValidationResponse(request, [url.hostname]) ?? originValidationResponse(request, [url.hostname])
    if (rejected !== undefined) return rejected
    const principal = await deps.authenticate(request, env)
    if (principal instanceof Response) return principal
    const owner: Owner = { userId: principal.ownerUserId }
    const parts = await partsFor(env, owner, url.origin, deps.wiring)
    const layer = walletLayer(parts)
    const handler = createMcpHandler((ctx) =>
      walletServer({
        run: (program) => runWallet(program, layer),
        era: ctx.era,
        client: principal.clientName,
        scopes: principal.scopes,
        origin: url.origin,
        readView: (name) => readView(env, url.origin, name),
      }),
    )
    return handler.fetch(request, {
      authInfo: {
        token: principal.token,
        clientId: principal.clientId,
        scopes: [...principal.scopes],
        ...(principal.expiresAt === undefined ? {} : { expiresAt: principal.expiresAt }),
      },
    })
  }
}
