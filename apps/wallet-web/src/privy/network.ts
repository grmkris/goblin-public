import { type Chain, type ChainKey, chainByKey } from '@goblin/wallet/chains'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type Address, createPublicClient, http } from 'viem'
import { FlowFailure } from './flow.ts'

const decodeHealth = Schema.decodeUnknownOption(Schema.Struct({ live: Schema.Boolean }))
let live: Promise<boolean> | undefined

/** Whether this deployment acts on mainnets (`GET /health`); asked once per page. */
const isLive = (): Promise<boolean> => {
  live ??= fetch('/health')
    .then((response) => response.json())
    .then((body: unknown) => {
      const health = Option.getOrUndefined(decodeHealth(body))
      if (health === undefined)
        throw new FlowFailure({ code: 'network', message: 'The wallet did not say which chains it uses.' })
      return health.live
    })
  live.catch(() => {
    // expected: the caller sees this failure through `live` itself; here it is only forgotten, so the next flow asks.
    live = undefined
  })
  return live
}

/** The chain a key names on this deployment: the mainnet when it is live, its testnet otherwise. */
export const chainFor = async (key: ChainKey): Promise<Chain> => chainByKey(key, await isLive())

const client = (chain: Chain) => createPublicClient({ transport: http(chain.rpcUrl) })

/** The account's next nonce, counting transactions still pending: what an EIP-7702 authorization must name. */
export const pendingNonce = (chain: Chain, address: Address): Promise<number> =>
  client(chain).getTransactionCount({ address, blockTag: 'pending' })
