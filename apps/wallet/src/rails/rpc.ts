import { httpJsonRpc, type JsonRpc } from '@goblin/wallet/balances'
import { chainByKey } from '@goblin/wallet/chains'
import type { ChainKey } from '@goblin/wallet/contract'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const Overrides = Schema.Record(Schema.String, Schema.String)
const decodeOverrides = Schema.decodeUnknownOption(Schema.fromJsonString(Overrides))

/**
 * JSON-RPC callers per chain on the selected network (`live`: mainnets, otherwise their testnets): the Worker's
 * `RPC_URLS` (a JSON object of chain id to URL) wins, the public RPC in the chain table is the default. An override is
 * keyed by chain id, so a mainnet URL never serves a testnet key. One caller per chain per isolate.
 */
export const rpcFromEnv = (rpcUrls: string, live: boolean): ((chain: ChainKey) => JsonRpc) => {
  const overrides = rpcUrls.trim() === '' ? undefined : Option.getOrUndefined(decodeOverrides(rpcUrls))
  const callers = new Map<ChainKey, JsonRpc>()
  return (chain) => {
    const cached = callers.get(chain)
    if (cached !== undefined) return cached
    const known = chainByKey(chain, live)
    const caller = httpJsonRpc(overrides?.[String(known.id)] ?? known.rpcUrl)
    callers.set(chain, caller)
    return caller
  }
}
