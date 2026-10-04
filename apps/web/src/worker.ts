import page from './server.tsx'
import runtime from '@purrable/runtime/worker'
export { PersonalAgent } from '@purrable/runtime/agent'

export default {
  async fetch(request: Request, env: Parameters<typeof runtime.fetch>[1], ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/.well-known/') ||
      url.pathname === '/health' ||
      url.pathname === '/mcp'
    )
      return runtime.fetch(request, env)
    return page.fetch(request)
  },
}
