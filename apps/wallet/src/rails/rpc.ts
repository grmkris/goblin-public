import { httpJsonRpc, type JsonRpc } from '@goblin/wallet/balances'
import { chainByCaip2 } from '@goblin/wallet/chains'
import type { ChainKey } from '@goblin/wallet/contract'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const CAIP2: Readonly<Record<ChainKey, string>> = {
  base: 'eip155:8453',
  ethereum: 'eip155:1',
  arbitrum: 'eip155:42161',
  tempo: 'eip155:4217',
}

const Overrides = Schema.Record(Schema.String, Schema.String)
const decodeOverrides = Schema.decodeUnknownOption(Schema.fromJsonString(Overrides))

/**
 * JSON-RPC callers per chain: the Worker's `RPC_URLS` (a JSON object of chain id to URL) wins, the public RPC in the
 * chain table is the default. One caller per chain per isolate.
 */
export const rpcFromEnv = (rpcUrls: string): ((chain: ChainKey) => JsonRpc) => {
  const overrides = rpcUrls.trim() === '' ? undefined : Option.getOrUndefined(decodeOverrides(rpcUrls))
  const callers = new Map<ChainKey, JsonRpc>()
  return (chain) => {
    const cached = callers.get(chain)
    if (cached !== undefined) return cached
    const caip2 = CAIP2[chain]
    const known = chainByCaip2(caip2)
    const url = overrides?.[String(known?.id)] ?? known?.rpcUrl
    if (url === undefined) throw new Error(`No RPC for ${chain}`)
    const caller = httpJsonRpc(url)
    callers.set(chain, caller)
    return caller
  }
}
