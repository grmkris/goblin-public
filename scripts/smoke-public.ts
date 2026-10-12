import { internalChecks } from './smoke-edge.ts'

/**
 * Production without a signed-in session: public health, admission, page, metadata, internal-route and canonical
 * redirect checks. Sign-up is invite-only, refused without the code, or open (owner, 2026-10-12: open with a free plan).
 */
type Client = {
  readonly origin: string
  send: (path: string, init?: RequestInit & { readonly owner?: boolean }) => Promise<Response>
  json: (path: string, init?: RequestInit & { readonly owner?: boolean }) => Promise<Record<string, unknown>>
}

export async function publicSmoke(
  dev: Client,
  health: Record<string, unknown>,
  signup: string,
  steps: Array<{ readonly step: string; readonly status: number }>,
  refusedSignup: () => Promise<void>,
): Promise<void> {
  if ((signup !== 'invite' && signup !== 'open') || health['mail'] !== true)
    throw new Error('prod_admission_policy_mismatch')
  const probe = await dev.send('/api/agent/usage', { owner: false })
  if (probe.status !== 401) throw new Error('anonymous_auth_probe_not_refused')
  await internalChecks(dev.origin, steps)
  if (signup === 'invite') await refusedSignup()
  const metadata = await dev.json('/.well-known/oauth-protected-resource', { owner: false })
  if (metadata['resource'] !== `${dev.origin}/mcp`) throw new Error('prod_mcp_resource_mismatch')
  // Home opens the last channel (ADR 0036): follow one redirect, only within the origin.
  const home = await dev.send('/', { owner: false })
  const location = home.headers.get('location')
  const target = location === null ? undefined : new URL(location, dev.origin)
  const page =
    home.status >= 300 && home.status < 400 && target?.origin === dev.origin
      ? await dev.send(target.pathname, { owner: false })
      : home
  if (!page.ok || !(await page.text()).includes('goblin')) throw new Error('prod_page_unavailable')
  const alias = await fetch(new URL('/health', `https://www.${new URL(dev.origin).hostname}`), { redirect: 'manual' })
  if (alias.status !== 301 || alias.headers.get('location') !== `${dev.origin}/health`)
    throw new Error('prod_alias_not_canonical')
  steps.push({ step: 'www redirects to canonical origin', status: alias.status })
}
