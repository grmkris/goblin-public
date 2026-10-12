import type { JsonRpc } from '@goblin/wallet/balances'
import { chainByKey } from '@goblin/wallet/chains'
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

/** Whether the owner's code delegates to this network's DeleGator; null when the chain could not be read. */
const delegated = (rpc: JsonRpc, owner: string, delegator: string): Promise<boolean | null> =>
  delegationOf(
    rpc,
    // SAFETY: the ledger's profile schema checked the owner address's `0x` pattern.
    owner as `0x${string}`,
  ).then(
    (current) => current !== null && current.toLowerCase() === delegator.toLowerCase(),
    // expected: unreadable code is reported as unknown; the caller decides what that means.
    () => null,
  )

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Reads the owner's code until it shows the delegation: right after the receipt, a load-balanced node one block behind
 * still serves the old code, and an applied upgrade would be reported as skipped.
 */
const delegatedAfterReceipt = async (
  rpc: JsonRpc,
  owner: string,
  delegator: string,
  wait: RailsDeps['wait'],
): Promise<boolean | null> => {
  let last: boolean | null = null
  for (let attempt = 0; attempt < (wait?.attempts ?? 5); attempt += 1) {
    last = await delegated(rpc, owner, delegator)
    if (last === true) return true
    await (wait?.sleep ?? pause)(wait?.intervalMs ?? 1500)
  }
  return last
}

/**
 * Relays the owner's signed EIP-7702 authorization and reports the result as an operation. `confirmed` means the
 * owner's code now delegates to this network's DeleGator, read back from the chain: a mined transaction whose
 * authorization the chain skipped is `failed`, and one still in flight is `submitted`.
 */
export const upgrade = async (request: UpgradeRequest, deps: RailsDeps): Promise<Operation> => {
  const { relay } = deps
  const owner = (await deps.profile()).ownerAddress
  if (relay === undefined) throw new RailError('No relay is configured on this deployment.')
  if (owner === undefined) throw new RailError('The owner address is not known yet.')
  const now = (deps.now ?? (() => new Date()))()
  const key = `upgrade:${request.chain}:${owner.toLowerCase()}:${request.authorization.nonce}`
  const terms = termsOf(request, owner, now)
  const base = { id: key, terms, termsHash: await termsHash(terms), limitsVersion: 0, createdAt: now.toISOString() }
  const failed = (reason: string): Operation => ({ ...base, status: 'failed', updatedAt: now.toISOString(), reason })
  const network = chainByKey(request.chain, deps.live)
  if (request.authorization.chainId !== network.id)
    return failed(`The authorization is not for ${network.name}, the network this wallet runs on.`)
  const rpc = deps.rpcFor(request.chain)
  const delegator = network.delegation.delegator
  // Already delegated to the DeleGator (a re-run of onboarding): confirm without paying gas again.
  if ((await delegated(rpc, owner, delegator)) === true)
    return { ...base, status: 'confirmed', updatedAt: now.toISOString(), payment: { rail: 'relay' } }
  try {
    const sent = await relay.upgrade({ key, chain: request.chain, owner, authorization: request.authorization })
    const payment = { rail: 'relay' as const, txHash: sent.txHash, settledAt: now.toISOString() }
    if (sent.status === 'pending') return { ...base, status: 'submitted', updatedAt: now.toISOString(), payment }
    if (sent.status !== 'success') return { ...failed('The upgrade transaction reverted.'), payment }
    const applied = await delegatedAfterReceipt(rpc, owner, delegator, deps.wait)
    if (applied === true) return { ...base, status: 'confirmed', updatedAt: now.toISOString(), payment }
    if (applied === null) return { ...base, status: 'submitted', updatedAt: now.toISOString(), payment }
    return { ...failed('The upgrade landed but the chain did not apply the authorization.'), payment }
  } catch (error) {
    // expected: a relay failure is the operation's `failed` state, not an exception, so the owner API can show it.
    const reason = error instanceof RelayError ? error.message : 'The relay could not send the upgrade.'
    return { ...base, status: 'failed', updatedAt: now.toISOString(), reason: reason.slice(0, 240) }
  }
}
