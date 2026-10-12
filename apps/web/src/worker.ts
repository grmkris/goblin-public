import page from './server.tsx'
import runtime from '@goblin/runtime/worker'
import { canonicalRedirect } from '@goblin/runtime/canonical'
export { PersonalAgent } from '@goblin/runtime/agent'

export default {
  scheduled: (event: ScheduledController, env: Parameters<typeof runtime.scheduled>[1]) =>
    runtime.scheduled(event, env),
  async fetch(request: Request, env: Parameters<typeof runtime.fetch>[1], ctx: ExecutionContext): Promise<Response> {
    const redirect = canonicalRedirect(request, env.APP_URL)
    if (redirect !== undefined) return redirect
    const url = new URL(request.url)
    if (
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/hooks/') ||
      url.pathname.startsWith('/.well-known/') ||
      url.pathname === '/health' ||
      url.pathname === '/mcp' ||
      url.pathname === '/v1/chat/completions'
    )
      return runtime.fetch(request, env, ctx)
    return page.fetch(request)
  },
}
