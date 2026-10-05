import page from './server.tsx'
import runtime from '@purrable/runtime/worker'
import { canonicalRedirect } from '@purrable/runtime/canonical'
export { PersonalAgent } from '@purrable/runtime/agent'

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
      url.pathname === '/mcp'
    )
      return runtime.fetch(request, env, ctx)
    const response = await page.fetch(request)
    if (url.pathname.startsWith('/invite/')) {
      const secured = new Response(response.body, response)
      secured.headers.set('cache-control', 'no-store')
      secured.headers.set('referrer-policy', 'no-referrer')
      return secured
    }
    return response
  },
}
