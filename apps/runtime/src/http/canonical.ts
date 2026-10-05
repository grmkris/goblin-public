/** Retire alternate hosts before authentication, hooks, assets or page rendering. */
export function canonicalRedirect(request: Request, appUrl: string): Response | undefined {
  const source = new URL(request.url)
  const target = new URL(appUrl)
  if (source.host === target.host && source.protocol === target.protocol) return undefined
  target.pathname = source.pathname
  target.search = source.search
  return Response.redirect(target.href, request.method === 'GET' || request.method === 'HEAD' ? 301 : 308)
}
