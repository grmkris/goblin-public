import { createMcpHandler } from 'agents/mcp/server'
import { inboundHosts } from '../../src/inbound/route.ts'
import { inboundServer } from '../../src/inbound/server.ts'

/** Fixture transport uses the real Agents SDK on a custom host; authentication is tested separately. */
export function inboundHostProbe(request: Request): Promise<Response> {
  const url = new URL('https://dev.purrable.lol/mcp')
  const headers = new Headers(request.headers)
  headers.set('host', url.host)
  const handler = createMcpHandler(
    () =>
      inboundServer({
        ask: async () => ({ status: 'running', operationId: 'host-test' }),
        recent: async () => [],
      }),
    { route: '/mcp', ...inboundHosts(url.origin) },
  )
  return handler.fetch(new Request(url, { method: request.method, headers, body: request.body }))
}
