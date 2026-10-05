import page from './server.tsx'
import runtime from '@purrable/runtime/worker'
import { canonicalRedirect } from '@purrable/runtime/canonical'
export { PersonalAgent } from '@purrable/runtime/agent'

export default {
  async fetch(request: Request, env: Parameters<typeof runtime.fetch>[1], ctx: ExecutionContext): Promise<Response> {
    const redirect = canonicalRedirect(request, env.APP_URL)
    if (redirect !== undefined) return redirect
    const url = new URL(request.url)
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/hooks/') ||
      url.pathname.startsWith('/.well-known/') ||
      url.pathname === '/health' ||
      url.pathname === '/mcp'
    )
      return runtime.fetch(request, env)
    return page.fetch(request)
  },
}
