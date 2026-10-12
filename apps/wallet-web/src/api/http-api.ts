// The real WalletApi: fetch over OwnerRoutes with the Privy access token, every response decoded with the contract's
// own schemas so a server that drifts from the contract fails loudly here rather than rendering garbage.
import { ApiError, OwnerRoutes } from '@goblin/wallet/contract'
import * as Data from 'effect/Data'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { WalletApi } from './types.ts'

type Route = {
  readonly method: string
  readonly path: string
  readonly response: Schema.Decoder<unknown>
}

/** A failed call, in the server's own words: what happened and, when it says, what to do about it. */
export class ApiFailure extends Data.TaggedError('ApiFailure')<{
  readonly code: string
  readonly message: string
}> {}

const failureOf = (code: string, message: string, recovery: string | undefined): ApiFailure =>
  new ApiFailure({ code, message: recovery === undefined ? message : `${message} ${recovery}` })

const decodeError = Schema.decodeUnknownOption(ApiError)

async function failure(response: Response): Promise<ApiFailure> {
  // expected: an error page that is not JSON falls through to the generic message below
  const body: unknown = await response.json().catch(() => undefined)
  const parsed = decodeError(body)
  if (Option.isSome(parsed)) {
    const { code, message, recovery } = parsed.value.error
    return failureOf(code, message, recovery)
  }
  return failureOf(`http_${response.status}`, `The wallet answered ${response.status}.`, 'Try again in a moment.')
}

type Call = <R extends Route>(
  route: R,
  options?: { readonly params?: Record<string, string>; readonly body?: unknown },
) => Promise<R['response']['Type']>

function makeCall(getToken: () => Promise<string | null>): Call {
  return async (route, options = {}) => {
    const token = await getToken()
    if (token === null) throw failureOf('signed_out', 'You are signed out.', 'Sign in again.')
    const path = route.path.replace(/:(\w+)/gu, (_, name: string) => encodeURIComponent(options.params?.[name] ?? ''))
    const response = await fetch(path, {
      method: route.method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    if (!response.ok) throw await failure(response)
    return Schema.decodeUnknownSync(route.response)(await response.json())
  }
}

const reads = (
  call: Call,
): Pick<
  WalletApi,
  'me' | 'status' | 'limits' | 'activity' | 'approval' | 'services' | 'addressBook' | 'connections' | 'oauthRequest'
> => ({
  me: () => call(OwnerRoutes.me),
  status: () => call(OwnerRoutes.status),
  limits: () => call(OwnerRoutes.limits),
  activity: () => call(OwnerRoutes.activity),
  approval: (operationId) => call(OwnerRoutes.approval, { params: { operationId } }),
  services: () => call(OwnerRoutes.services),
  addressBook: () => call(OwnerRoutes.addressBook),
  connections: () => call(OwnerRoutes.connections),
  oauthRequest: (id) => call(OwnerRoutes.oauthRequest, { params: { id } }),
})

const writes = (
  call: Call,
): Pick<WalletApi, 'createAgent' | 'setLimits' | 'decide' | 'disconnect' | 'oauthDecide' | 'revokeAll'> => ({
  createAgent: () => call(OwnerRoutes.createAgent),
  setLimits: (limits) => call(OwnerRoutes.setLimits, { body: limits }),
  decide: (operationId, decision) => call(OwnerRoutes.decide, { params: { operationId }, body: decision }),
  disconnect: (id) => call(OwnerRoutes.disconnect, { params: { id } }),
  oauthDecide: (id, decision) => call(OwnerRoutes.oauthDecide, { params: { id }, body: { decision } }),
  revokeAll: () => call(OwnerRoutes.revokeAll),
})

export function createHttpApi(getToken: () => Promise<string | null>): WalletApi {
  const call = makeCall(getToken)
  return { ...reads(call), ...writes(call) }
}
