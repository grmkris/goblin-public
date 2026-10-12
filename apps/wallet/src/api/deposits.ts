import { BridgeError, depositStatus as relayDepositStatus, quoteDepositAddress } from '@goblin/wallet/bridge'
import { DepositRequest } from '@goblin/wallet/contract'
import { apiError, json } from '../http.ts'
import { type ApiCall, readBody } from './call.ts'

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

/**
 * `POST /api/deposits`: a one-off Relay deposit address that delivers to the owner's own account on Base. The wallet
 * signs nothing and holds nothing; whoever sends to the address pays, and a failed fill refunds to the owner.
 */
export async function deposit(call: ApiCall): Promise<Response> {
  const body = await readBody(call.request, DepositRequest)
  if (!body.ok) return body.response
  if (call.env.WALLET_LIVE !== '1')
    return apiError('mainnet_only', 'Deposit addresses run on mainnet only; this wallet is on testnets.', 409)
  const recipient = call.owner.ownerAddress
  try {
    const quote = await quoteDepositAddress({ ...body.value, recipient, fetchFn: call.wiring.fetchFn })
    return json({
      ...quote,
      from: body.value.from,
      asset: body.value.asset,
      amount: body.value.amount,
      receive: body.value.receive,
      recipient,
    })
  } catch (error) {
    // expected: a refused quote is the owner's 409; Relay not answering is a retryable 502, not a server fault.
    if (error instanceof BridgeError) return apiError('deposit_unavailable', error.message, 409)
    return apiError('relay_unavailable', 'Relay did not answer; try again in a moment.', 502)
  }
}

/** `GET /api/deposits/:depositAddress`: Relay's progress for that address; `unknown` when Relay does not say. */
export async function depositStatus(call: ApiCall): Promise<Response> {
  const depositAddress = call.params['depositAddress'] ?? ''
  if (!ADDRESS.test(depositAddress)) return apiError('bad_request', 'That is not a deposit address.', 400)
  try {
    return json({ depositAddress, ...(await relayDepositStatus(depositAddress, call.wiring.fetchFn)) })
  } catch {
    // expected: an unreadable answer from Relay is the same as no answer; the owner's balance still shows the arrival.
    return json({ depositAddress, status: 'unknown', txHashes: [] })
  }
}
