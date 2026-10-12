import { DepositRequest } from '@goblin/wallet/contract'
import { apiError, json } from '../http.ts'
import { RailError } from '../rails/deps.ts'
import { depositAddress, depositProgress } from '../rails/deposit.ts'
import { type ApiCall, readBody } from './call.ts'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

/**
 * `POST /api/deposits`: a one-off Relay deposit address, delivering USDC.e to the agent on Tempo or ETH and USDC to
 * the owner's own account on Base (`rails/deposit.ts`).
 */
export async function deposit(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, DepositRequest)
  if (!body.ok) return body.response
  const live = call.env.WALLET_LIVE === '1'
  if (!live) return apiError('mainnet_only', 'Deposit addresses run on mainnet only; this wallet is on testnets.', 409)
  try {
    const profile = async () => ({ ...(await call.ledger.profile()), ownerAddress: call.owner.ownerAddress })
    const { fetchFn } = call.wiring
    return json(await depositAddress(body.value, { live, profile, ...(fetchFn === undefined ? {} : { fetchFn }) }))
  } catch (error) {
    // expected: a refused quote is the owner's 409; Relay not answering is a retryable 502, not a server fault.
    if (error instanceof RailError) return apiError('deposit_unavailable', error.message, 409)
    return apiError('relay_unavailable', 'Relay did not answer; try again in a moment.', 502)
  }
}

/** `GET /api/deposits/:depositAddress`: Relay's progress for that address; `unknown` when Relay does not say. */
export async function depositStatus(call: ApiCall): Promise<Response> {
  const address = call.params['depositAddress'] ?? ''
  if (!ADDRESS.test(address)) return apiError('bad_request', 'That is not a deposit address.', 400)
  return json(await depositProgress(address, call.wiring.fetchFn))
}
