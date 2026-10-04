import { Clock, Effect, Predicate } from 'effect'
import type { RuntimeEnv } from '../env.ts'
import { D1GrantStore } from './store.ts'
import { requireOwnerSession } from './service.ts'
import type { GrantCapability } from './principal.ts'

const record = (value: unknown): value is Record<string, unknown> => Predicate.isObject(value)
const text = (value: unknown): value is string => Predicate.isString(value) && value.length > 0 && value.length <= 2048
const capability = (value: unknown): value is GrantCapability =>
  value === 'tool' || value === 'resource' || value === 'prompt'
/** Owner-cookie-only grant administration. Never trusts the body to select issuer or subject. */
export const handleGrantRequest = async (request: Request, env: RuntimeEnv): Promise<Response> => {
  const owner = await requireOwnerSession(request, env)
  const store = new D1GrantStore(env.AUTH_DB)
  if (request.method === 'GET') return Response.json({ grants: await store.list(owner) })
  if (request.method !== 'POST' && request.method !== 'DELETE')
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST, DELETE' } })
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== new URL(env.APP_URL).origin)
    return Response.json({ error: 'origin_denied' }, { status: 403 })
  const body: unknown = await request.json()
  if (!record(body) || !text(body['clientId']) || !text(body['serverId']))
    return Response.json({ error: 'grant_invalid' }, { status: 400 })
  const key = { issuer: owner.issuer, subject: owner.subject, clientId: body['clientId'], serverId: body['serverId'] }
  const now = Math.floor((await Effect.runPromise(Clock.currentTimeMillis)) / 1000)
  if (request.method === 'DELETE') {
    await store.revoke(key, now)
    return Response.json({ revoked: true })
  }
  if (
    !capability(body['capability']) ||
    !text(body['name']) ||
    body['name'].includes('*') ||
    !Array.isArray(body['scopes']) ||
    !body['scopes'].every((scope) => Predicate.isString(scope) && owner.scopes.includes(scope))
  )
    return Response.json({ error: 'grant_invalid' }, { status: 400 })
  const expiresAt = body['expiresAt']
  if (
    expiresAt !== undefined &&
    (!Predicate.isNumber(expiresAt) || !Number.isSafeInteger(expiresAt) || expiresAt <= now)
  )
    return Response.json({ error: 'grant_expiry_invalid' }, { status: 400 })
  const grant = {
    ...key,
    capability: body['capability'],
    name: body['name'],
    scopes: body['scopes'],
    generation: await store.currentGeneration(key),
    ...(Predicate.isNumber(expiresAt) ? { expiresAt } : {}),
  }
  await store.create(grant, now)
  return Response.json({ grant }, { status: 201 })
}
