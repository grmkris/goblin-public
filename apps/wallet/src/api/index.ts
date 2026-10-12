import { OwnerRoutes } from '@goblin/wallet/contract'
import { partsFor, type Wiring } from '../context.ts'
import type { WalletEnv } from '../env.ts'
import { apiError } from '../http.ts'
import { type IdentityResult, type IdentityVerifier, refusalStatus } from '../identity.ts'
import type { AuthApi } from '../oauth/durable.ts'
import { runWallet } from '../runtime.ts'
import { walletLayer } from '../services/index.ts'
import { approval, decide } from './approvals.ts'
import type { ApiCall, Route } from './call.ts'
import { connections, disconnectOne, revokeAll } from './connections.ts'
import { deposit, depositStatus } from './deposits.ts'
import { limits, setLimits } from './limits.ts'
import { activity, addressBook, services } from './lists.ts'
import { checkOperation } from './operations.ts'
import { me, status } from './me.ts'
import { decidePolicyChange, policyChanges } from './policy-changes.ts'
import { returnCheck } from './returns.ts'
import { allowanceConfirm, allowancePrepare, createAgent, upgrade, upgradePrepare } from './onboarding.ts'

export interface ApiDeps {
  readonly identity: (env: WalletEnv) => IdentityVerifier
  readonly auth: (env: WalletEnv) => AuthApi
  readonly wiring: Wiring
}

interface Entry {
  readonly method: string
  readonly pattern: RegExp
  readonly keys: readonly string[]
  readonly route: Route
}

/** `/api/approvals/:operationId` as a pattern and the names of its parameters. */
const compile = (method: string, path: string, route: Route): Entry => {
  const keys: string[] = []
  const source = path.replace(/:([A-Za-z]+)/gu, (_match, key: string) => {
    keys.push(key)
    return '([^/]{1,200})'
  })
  return { method, pattern: new RegExp(`^${source}$`, 'u'), keys, route }
}

const ENTRIES: readonly Entry[] = [
  compile(OwnerRoutes.me.method, OwnerRoutes.me.path, me),
  compile(OwnerRoutes.status.method, OwnerRoutes.status.path, status),
  compile(OwnerRoutes.createAgent.method, OwnerRoutes.createAgent.path, createAgent),
  compile(OwnerRoutes.upgradePrepare.method, OwnerRoutes.upgradePrepare.path, upgradePrepare),
  compile(OwnerRoutes.upgrade.method, OwnerRoutes.upgrade.path, upgrade),
  compile(OwnerRoutes.allowancePrepare.method, OwnerRoutes.allowancePrepare.path, allowancePrepare),
  compile(OwnerRoutes.allowanceConfirm.method, OwnerRoutes.allowanceConfirm.path, allowanceConfirm),
  compile(OwnerRoutes.limits.method, OwnerRoutes.limits.path, limits),
  compile(OwnerRoutes.setLimits.method, OwnerRoutes.setLimits.path, setLimits),
  compile(OwnerRoutes.activity.method, OwnerRoutes.activity.path, activity),
  compile(OwnerRoutes.checkOperation.method, OwnerRoutes.checkOperation.path, checkOperation),
  compile(OwnerRoutes.approval.method, OwnerRoutes.approval.path, approval),
  compile(OwnerRoutes.decide.method, OwnerRoutes.decide.path, decide),
  compile(OwnerRoutes.services.method, OwnerRoutes.services.path, services),
  compile(OwnerRoutes.addressBook.method, OwnerRoutes.addressBook.path, addressBook),
  compile(OwnerRoutes.connections.method, OwnerRoutes.connections.path, connections),
  compile(OwnerRoutes.disconnect.method, OwnerRoutes.disconnect.path, disconnectOne),
  compile(OwnerRoutes.policyChanges.method, OwnerRoutes.policyChanges.path, policyChanges),
  compile(OwnerRoutes.decidePolicyChange.method, OwnerRoutes.decidePolicyChange.path, decidePolicyChange),
  compile(OwnerRoutes.deposit.method, OwnerRoutes.deposit.path, deposit),
  compile(OwnerRoutes.depositStatus.method, OwnerRoutes.depositStatus.path, depositStatus),
  compile(OwnerRoutes.revokeAll.method, OwnerRoutes.revokeAll.path, revokeAll),
  compile(OwnerRoutes.returnCheck.method, OwnerRoutes.returnCheck.path, returnCheck),
]

const match = (
  method: string,
  pathname: string,
): { entry: Entry; params: Record<string, string> } | 'method' | undefined => {
  let pathMatched = false
  for (const entry of ENTRIES) {
    const found = entry.pattern.exec(pathname)
    if (found === null) continue
    pathMatched = true
    if (entry.method !== method) continue
    const params = Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(found[index + 1] ?? '')]))
    return { entry, params }
  }
  return pathMatched ? 'method' : undefined
}

const refused = (result: Extract<IdentityResult, { ok: false }>): Response => {
  const httpStatus = refusalStatus(result.reason)
  return apiError(
    result.reason,
    httpStatus === 503 ? 'Sign-in is unavailable right now.' : 'Sign in again to continue.',
    httpStatus,
    httpStatus === 503 ? 'Try again in a moment.' : undefined,
  )
}

/** The owner API under `/api/*`: every route acts for the signed-in Privy user and takes no owner id from the request. */
export function createApi(deps: ApiDeps): (request: Request, env: WalletEnv) => Promise<Response> {
  return async (request, env) => {
    const url = new URL(request.url)
    const matched = match(request.method, url.pathname)
    if (matched === undefined) return apiError('not_found', 'No such route.', 404)
    if (matched === 'method') return apiError('method_not_allowed', 'This route does not take that method.', 405)
    const identity = await deps.identity(env).verifyRequest(request)
    if (!identity.ok) return refused(identity)
    const owner = identity.owner
    const parts = await partsFor(env, { userId: owner.userId }, url.origin, deps.wiring)
    const layer = walletLayer(parts)
    const call: ApiCall = {
      request,
      env,
      owner,
      origin: url.origin,
      params: matched.params,
      ledger: parts.ledger,
      rails: parts.rails,
      auth: deps.auth(env),
      wiring: deps.wiring,
      run: (program) => runWallet(program, layer),
    }
    return matched.entry.route(call)
  }
}
