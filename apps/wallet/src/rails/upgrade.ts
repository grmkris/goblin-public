import { termsHash, type Operation, type Terms, type UpgradeRequest } from '@goblin/wallet/contract'
import { delegationOf, RelayError } from '@goblin/wallet/relay'
import { RailError, type RailsDeps } from './deps.ts'

const NATIVE = '0x0000000000000000000000000000000000000000'

/** The upgrade as an operation: free for the owner (the relay pays gas), recorded like any other. */
const termsOf = (request: UpgradeRequest, owner: string, now: Date): Terms => ({
  kind: 'upgrade',
  chain: request.chain,
  rail: 'relay',
  subject: 'EIP-7702 account upgrade',
  token: { symbol: 'ETH', address: NATIVE, decimals: 18 },
  amount: '0',
  amountUsd: '0',
  recipient: owner,
  expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
})

/** Relays the owner's signed EIP-7702 authorization and reports the result as an operation. */
export const upgrade = async (request: UpgradeRequest, deps: RailsDeps): Promise<Operation> => {
  const { relay } = deps
  const owner = (await deps.profile()).ownerAddress
  if (relay === undefined) throw new RailError('No relay is configured on this deployment.')
  if (owner === undefined) throw new RailError('The owner address is not known yet.')
  const now = (deps.now ?? (() => new Date()))()
  const key = `upgrade:${request.chain}:${owner.toLowerCase()}:${request.authorization.nonce}`
  const terms = termsOf(request, owner, now)
  const base = { id: key, terms, termsHash: await termsHash(terms), limitsVersion: 0, createdAt: now.toISOString() }
  // Already delegated to the contract the owner signed for (a re-run of onboarding): confirm without paying gas again.
  const current = await delegationOf(
    deps.rpcFor(request.chain),
    // SAFETY: the ledger's profile schema checked the owner address's `0x` pattern.
    owner as `0x${string}`,
  ).catch(() => {
    // expected: an unreadable code only means we cannot skip the relay; sending the upgrade is still correct.
    return null
  })
  if (current !== null && current.toLowerCase() === request.authorization.address.toLowerCase())
    return { ...base, status: 'confirmed', updatedAt: now.toISOString(), payment: { rail: 'relay' } }
  try {
    const sent = await relay.upgrade({ key, chain: request.chain, owner, authorization: request.authorization })
    const status = sent.status === 'success' ? 'confirmed' : sent.status === 'pending' ? 'submitted' : 'failed'
    return {
      ...base,
      status,
      updatedAt: now.toISOString(),
      payment: { rail: 'relay', txHash: sent.txHash, settledAt: now.toISOString() },
      ...(status === 'failed' ? { reason: 'The upgrade transaction reverted.' } : {}),
    }
  } catch (error) {
    // expected: a relay failure is the operation's `failed` state, not an exception, so the owner API can show it.
    const reason = error instanceof RelayError ? error.message : 'The relay could not send the upgrade.'
    return { ...base, status: 'failed', updatedAt: now.toISOString(), reason: reason.slice(0, 240) }
  }
}
