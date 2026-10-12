import { BridgeError, depositStatus as relayDepositStatus, quoteDepositAddress } from '@goblin/wallet/bridge'
import type { DepositAddress, DepositRequest, DepositStatus } from '@goblin/wallet/contract'
import { RailError, type RailsDeps } from './deps.ts'

type DepositDeps = Pick<RailsDeps, 'live' | 'profile' | 'fetchFn'>

/**
 * A one-off Relay deposit address for `request`. USDC.e lands in the agent's wallet on Tempo, where it pays MPP services
 * and paid inference; ETH and USDC land in the owner's account on Base, behind the allowance. The wallet signs nothing
 * and holds nothing: whoever sends to the address pays, and a failed fill refunds to the recipient on the origin chain.
 */
export const depositAddress = async (request: DepositRequest, deps: DepositDeps): Promise<DepositAddress> => {
  if (!deps.live) throw new RailError('Deposit addresses run on mainnet only; this wallet is on testnets.')
  const profile = await deps.profile()
  const recipient = request.receive === 'USDC.e' ? profile.agentAddress : profile.ownerAddress
  if (recipient === undefined)
    throw new RailError(
      request.receive === 'USDC.e'
        ? 'The owner has not created the agent wallet yet.'
        : 'The owner wallet is not known yet; sign in to the wallet first.',
    )
  try {
    const quote = await quoteDepositAddress({ ...request, recipient, fetchFn: deps.fetchFn })
    return { ...quote, ...request, recipient }
  } catch (error) {
    // expected: Relay refusing the quote is the caller's to fix (amount, pair); Relay not answering stays a throw.
    if (error instanceof BridgeError) throw new RailError(error.message)
    throw error
  }
}

/** Relay's progress for one deposit address; `unknown` when Relay does not say, and the balance shows the arrival. */
export const depositProgress = async (address: string, fetchFn?: typeof fetch): Promise<DepositStatus> => {
  try {
    return { depositAddress: address, ...(await relayDepositStatus(address, fetchFn)) }
  } catch {
    // expected: an unreadable answer from Relay is the same as no answer.
    return { depositAddress: address, status: 'unknown', txHashes: [] }
  }
}
