// EIP-7702 reads for an owner's account upgrade: what its code delegates to, who signed an authorization, and the
// account nonce a new authorization must name. Each is one RPC read or a local recovery; nothing here signs or sends.
import { recoverAuthorizationAddress } from 'viem/utils'
import type { SignedAuthorization } from '../contract/signer.ts'
import { toAddress, toHex } from './hex.ts'
import { quantity, type JsonRpc } from './rpc.ts'

const DELEGATION_PREFIX = '0xef0100'

/** The implementation an address delegates to under EIP-7702 (lower case), or null for a plain account or contract. */
export const delegationOf = async (rpc: JsonRpc, address: string): Promise<string | null> => {
  const code = await rpc('eth_getCode', [address, 'latest'])
  if (typeof code !== 'string') return null
  const lower = code.toLowerCase()
  if (lower.length !== 48 || !lower.startsWith(DELEGATION_PREFIX)) return null
  return `0x${lower.slice(DELEGATION_PREFIX.length)}`
}

/** The address that signed an EIP-7702 authorization. */
export const authorizationSignedBy = (auth: SignedAuthorization): Promise<string> =>
  recoverAuthorizationAddress({
    authorization: {
      address: toAddress(auth.address),
      chainId: auth.chainId,
      nonce: auth.nonce,
      r: toHex(auth.r),
      s: toHex(auth.s),
      yParity: auth.yParity,
    },
  })

/**
 * The account's next nonce, counting its pending transactions. An authorization someone else sends (a relay, a
 * bundler) must name exactly this one; the chain skips a stale one.
 */
export const pendingNonce = async (rpc: JsonRpc, address: string): Promise<bigint> =>
  quantity(await rpc('eth_getTransactionCount', [address, 'pending']))
