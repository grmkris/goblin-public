/**
 * The relay: a gas-paying EOA that sends the owner's EIP-7702 upgrade (a type-4 transaction carrying the owner's signed
 * authorization). The owner never needs gas. The relay holds only gas money, signs only these transactions, and refuses
 * to pay above a per-chain ceiling. Before it signs, the authorization must be for the selected network's chain id
 * (never 0) and DeleGator, signed by the owner, and carry the owner's current account nonce (EIP-7702 skips a stale
 * one while the relay still pays), and the owner and the chain must be within their daily upgrade quota. One relay
 * transaction is in flight per chain at a time. The signed bytes are stored before they are broadcast, so a crash
 * rebroadcasts the exact same transaction, never a second one. In the Worker the store and this class live in one
 * `WalletRelay` Durable Object per chain and relay address, which makes the queue below global.
 */
import * as Data from 'effect/Data'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverAuthorizationAddress } from 'viem/utils'
import { keccak256, type Address, type Hex, type LocalAccount } from 'viem'
import { toAddress, toHex } from '../balances/hex.ts'
import { field, quantity, type JsonRpc } from '../balances/rpc.ts'
import { chainByKey } from '../chains/index.ts'
import type { ChainKey, SignedAuthorization } from '../contract/index.ts'

export type RelayChain = Extract<ChainKey, 'base' | 'ethereum' | 'arbitrum' | 'tempo'>

/** The chain id and DeleGator of a chain on the selected network (mainnets when live, their testnets otherwise). */
const chainFacts = (chain: RelayChain, live: boolean) => {
  const network = chainByKey(chain, live)
  return { id: network.id, delegator: network.delegation.delegator }
}

export type RelayStatus = 'pending' | 'success' | 'reverted' | 'dropped'

export interface RelayRecord {
  readonly key: string
  readonly chain: RelayChain
  /** The owner whose authorization the transaction carries (lowercase). */
  readonly owner: string
  /** Unix milliseconds when it was signed; the daily quota counts these. */
  readonly createdAt: number
  readonly rawTx: Hex
  readonly txHash: Hex
  readonly nonce: number
  readonly status: RelayStatus
}

/** Where signed relay transactions persist (a Durable Object table in the Worker, a Map in tests). */
export interface RelayStore {
  find(key: string): Promise<RelayRecord | undefined>
  /** Inserts, or replaces a dropped record under the same key. */
  insert(record: RelayRecord): Promise<void>
  setStatus(key: string, status: RelayStatus): Promise<void>
  pending(chain: RelayChain): Promise<readonly RelayRecord[]>
  /** Transactions signed on `chain` since `since` (ms), for one owner when given. */
  countSince(chain: RelayChain, since: number, owner?: string): Promise<number>
  /** The highest nonce ever signed on `chain`, so a lagging node never makes the relay reuse one. */
  highestNonce(chain: RelayChain): Promise<number | undefined>
}

export interface RelayQuota {
  /** Upgrades one owner may have signed per chain in 24 hours. */
  readonly perOwner: number
  /** Upgrades the relay signs per chain in 24 hours, for everyone. */
  readonly perChain: number
}

export const DEFAULT_RELAY_QUOTA: RelayQuota = { perOwner: 3, perChain: 30 }
const DAY_MS = 86_400_000

export interface GasCeiling {
  /** The most the relay pays per unit of gas (wei). A quote above it is refused, never overpaid. */
  readonly maxFeePerGas: bigint
  readonly gasLimit: bigint
}

const GWEI = 1_000_000_000n
export const DEFAULT_GAS_CEILINGS: Readonly<Record<RelayChain, GasCeiling>> = {
  base: { maxFeePerGas: 2n * GWEI, gasLimit: 150_000n },
  arbitrum: { maxFeePerGas: 2n * GWEI, gasLimit: 400_000n },
  ethereum: { maxFeePerGas: 30n * GWEI, gasLimit: 150_000n },
  // Tempo: base fee 0.6 gwei, and a 7702 upgrade used 533k gas on Moderato (new-account state costs more there).
  tempo: { maxFeePerGas: 3n * GWEI, gasLimit: 1_000_000n },
}

export class RelayError extends Data.TaggedError('RelayError')<{
  readonly code: 'bad_request' | 'gas_ceiling' | 'dropped' | 'reverted' | 'busy' | 'quota'
  readonly message: string
}> {
  constructor(code: RelayError['code'], message: string) {
    super({ code, message })
  }
}

export interface UpgradeRequest {
  /** Stable per upgrade: the same key finds the same stored transaction. */
  readonly key: string
  readonly chain: RelayChain
  /** The owner's address, which signed the authorization. */
  readonly owner: string
  readonly authorization: SignedAuthorization
}

export interface RelayResult {
  readonly txHash: Hex
  readonly status: RelayStatus
  readonly nonce: number
}

export interface RelayDeps {
  /** Mainnets when true (`WALLET_LIVE=1`), their testnets otherwise: chain ids and the DeleGator follow it. */
  readonly live: boolean
  readonly account: LocalAccount
  readonly store: RelayStore
  readonly rpc: (chain: RelayChain) => JsonRpc
  readonly ceilings?: Readonly<Record<RelayChain, GasCeiling>>
  readonly quota?: RelayQuota
  readonly now?: () => number
  /** Waits between receipt polls; injectable. */
  readonly sleep?: (ms: number) => Promise<void>
  readonly receiptAttempts?: number
}

const DELEGATION_PREFIX = '0xef0100'

/** The implementation an address delegates to under EIP-7702, or null for a plain account or contract. */
export const delegationOf = async (rpc: JsonRpc, address: Address): Promise<Address | null> => {
  const code = await rpc('eth_getCode', [address, 'latest'])
  if (typeof code !== 'string') return null
  const lower = code.toLowerCase()
  if (lower.length !== 48 || !lower.startsWith(DELEGATION_PREFIX)) return null
  return `0x${lower.slice(DELEGATION_PREFIX.length)}`
}

/**
 * Relay sends are serialized per relay address and chain: a nonce read and the signed submission must not interleave,
 * or two upgrades would sign the same nonce. The queue lives in one isolate; the Worker makes that global by running
 * every send for a chain and address in one Durable Object.
 */
const queues = new Map<string, Promise<unknown>>()
const withRelayNonce = <T>(relay: Address, chain: RelayChain, fn: () => Promise<T>): Promise<T> => {
  const key = `${relay.toLowerCase()}:${chain}`
  const result = (queues.get(key) ?? Promise.resolve()).then(fn)
  const settled = result.catch(
    // expected: the queue only orders work; each caller sees its own failure through `result`.
    () => undefined,
  )
  queues.set(key, settled)
  return result
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface Receipt {
  readonly status: 'success' | 'reverted'
}

const readReceipt = async (rpc: JsonRpc, hash: Hex): Promise<Receipt | undefined> => {
  const raw = await rpc('eth_getTransactionReceipt', [hash])
  if (typeof raw !== 'object' || raw === null) return undefined
  return { status: field(raw, 'status') === '0x1' ? 'success' : 'reverted' }
}

export class RelaySender {
  readonly #deps: RelayDeps

  constructor(deps: RelayDeps) {
    this.#deps = deps
  }

  get address(): Address {
    return this.#deps.account.address
  }

  #ceiling(chain: RelayChain): GasCeiling {
    return (this.#deps.ceilings ?? DEFAULT_GAS_CEILINGS)[chain]
  }

  async #validate(request: UpgradeRequest): Promise<void> {
    const facts = chainFacts(request.chain, this.#deps.live)
    const auth = request.authorization
    // Chain id 0 would be valid on every chain; the relay pays for the one network it is configured for only.
    if (auth.chainId !== facts.id)
      throw new RelayError('bad_request', "the authorization is not for this network's chain")
    if (auth.address.toLowerCase() !== facts.delegator.toLowerCase())
      throw new RelayError('bad_request', 'the authorization delegates to an unknown implementation')
    const signer = await recoverAuthorizationAddress({
      authorization: {
        address: toAddress(auth.address),
        chainId: auth.chainId,
        nonce: auth.nonce,
        r: toHex(auth.r),
        s: toHex(auth.s),
        yParity: auth.yParity,
      },
    })
    if (signer.toLowerCase() !== request.owner.toLowerCase())
      throw new RelayError('bad_request', 'the authorization was not signed by the owner')
  }

  /** Reads the fee market and refuses above the ceiling. */
  async #fees(rpc: JsonRpc, chain: RelayChain) {
    const ceiling = this.#ceiling(chain)
    const block = await rpc('eth_getBlockByNumber', ['latest', false])
    const baseFee = quantity(field(block, 'baseFeePerGas') ?? '0x0')
    // expected: nodes without eth_maxPriorityFeePerGas get a 0.1 gwei tip.
    const tip = await rpc('eth_maxPriorityFeePerGas', []).then(quantity, () => GWEI / 10n)
    const maxFeePerGas = baseFee * 2n + tip
    if (maxFeePerGas > ceiling.maxFeePerGas)
      throw new RelayError('gas_ceiling', `gas price ${maxFeePerGas} wei is above the ceiling ${ceiling.maxFeePerGas}`)
    return { maxFeePerGas, maxPriorityFeePerGas: tip > maxFeePerGas ? maxFeePerGas : tip }
  }

  async #gas(rpc: JsonRpc, request: UpgradeRequest): Promise<bigint> {
    const ceiling = this.#ceiling(request.chain)
    const estimate = await rpc('eth_estimateGas', [
      {
        from: this.address,
        to: request.owner,
        data: '0x',
        authorizationList: [
          {
            chainId: `0x${request.authorization.chainId.toString(16)}`,
            address: request.authorization.address,
            nonce: `0x${request.authorization.nonce.toString(16)}`,
            yParity: `0x${request.authorization.yParity.toString(16)}`,
            r: request.authorization.r,
            s: request.authorization.s,
          },
        ],
      },
    ])
      .then(quantity)
      // expected: a node that cannot estimate a type-4 transaction gets the fixed 100k gas, capped by the ceiling.
      .catch(() => 100_000n)
    const padded = (estimate * 13n) / 10n
    return padded > ceiling.gasLimit ? ceiling.gasLimit : padded
  }

  /** Quota and freshness, checked only before a new transaction is signed. */
  async #admit(request: UpgradeRequest, rpc: JsonRpc): Promise<void> {
    const { store } = this.#deps
    const quota = this.#deps.quota ?? DEFAULT_RELAY_QUOTA
    const since = (this.#deps.now ?? Date.now)() - DAY_MS
    const owner = request.owner.toLowerCase()
    if ((await store.countSince(request.chain, since, owner)) >= quota.perOwner)
      throw new RelayError('quota', "this owner has used today's upgrade attempts on this chain")
    if ((await store.countSince(request.chain, since)) >= quota.perChain)
      throw new RelayError('quota', "the relay has sent today's upgrades on this chain; try again tomorrow")
    const current = quantity(await rpc('eth_getTransactionCount', [request.owner, 'pending']))
    if (BigInt(request.authorization.nonce) !== current)
      throw new RelayError('bad_request', "the authorization nonce is not the owner's current account nonce")
  }

  async #nextNonce(chain: RelayChain, rpc: JsonRpc): Promise<number> {
    const onChain = Number(quantity(await rpc('eth_getTransactionCount', [this.address, 'pending'])))
    const highest = await this.#deps.store.highestNonce(chain)
    return highest === undefined || highest < onChain ? onChain : highest + 1
  }

  async #sign(request: UpgradeRequest, rpc: JsonRpc): Promise<RelayRecord> {
    const facts = chainFacts(request.chain, this.#deps.live)
    const nonce = await this.#nextNonce(request.chain, rpc)
    const [fees, gas] = await Promise.all([this.#fees(rpc, request.chain), this.#gas(rpc, request)])
    const rawTx = await this.#deps.account.signTransaction({
      type: 'eip7702',
      chainId: facts.id,
      to: toAddress(request.owner),
      data: '0x',
      value: 0n,
      nonce,
      gas,
      ...fees,
      authorizationList: [
        {
          address: toAddress(request.authorization.address),
          chainId: request.authorization.chainId,
          nonce: request.authorization.nonce,
          r: toHex(request.authorization.r),
          s: toHex(request.authorization.s),
          yParity: request.authorization.yParity,
        },
      ],
    })
    return {
      key: request.key,
      chain: request.chain,
      owner: request.owner.toLowerCase(),
      createdAt: (this.#deps.now ?? Date.now)(),
      rawTx,
      txHash: keccak256(rawTx),
      nonce,
      status: 'pending',
    }
  }

  /**
   * Sends the owner's upgrade. Idempotent on `request.key`: a stored transaction is reconciled and its identical bytes
   * rebroadcast; only a dropped one is signed again (under the quota). The transaction is stored before it is broadcast.
   */
  upgrade(request: UpgradeRequest): Promise<RelayResult> {
    return withRelayNonce(this.address, request.chain, async () => {
      await this.#validate(request)
      const rpc = this.#deps.rpc(request.chain)
      const stored = await this.#deps.store.find(request.key)
      if (stored !== undefined && stored.owner !== request.owner.toLowerCase())
        throw new RelayError('bad_request', 'the upgrade key belongs to another owner')
      if (stored !== undefined && stored.status !== 'dropped') return this.#settle(stored, rpc)
      await this.#reconcilePending(request.chain)
      if ((await this.#deps.store.pending(request.chain)).length > 0)
        throw new RelayError('busy', 'an earlier upgrade on this chain is still confirming; try again in a minute')
      await this.#admit(request, rpc)
      const record = await this.#sign(request, rpc)
      await this.#deps.store.insert(record)
      return this.#settle(record, rpc)
    })
  }

  /** Reconciles every stored pending transaction on a chain; safe to run on a timer. */
  reconcile(chain: RelayChain): Promise<void> {
    return withRelayNonce(this.address, chain, () => this.#reconcilePending(chain))
  }

  async #reconcilePending(chain: RelayChain): Promise<void> {
    const rpc = this.#deps.rpc(chain)
    for (const record of await this.#deps.store.pending(chain))
      await this.#settle(record, rpc).catch((error: unknown) => {
        // expected: a dropped record is marked by #settle and must not block the next upgrade; anything else must.
        if (!(error instanceof RelayError && error.code === 'dropped')) throw error
      })
  }

  async #settle(record: RelayRecord, rpc: JsonRpc): Promise<RelayResult> {
    const done = (status: RelayStatus): RelayResult => ({ txHash: record.txHash, nonce: record.nonce, status })
    if (record.status === 'success' || record.status === 'reverted') return done(record.status)
    let receipt = await readReceipt(rpc, record.txHash)
    if (receipt === undefined) {
      const latest = quantity(await rpc('eth_getTransactionCount', [this.address, 'latest']))
      if (latest > BigInt(record.nonce)) {
        await this.#deps.store.setStatus(record.key, 'dropped')
        throw new RelayError('dropped', 'the relay transaction was dropped; its nonce was used by another transaction')
      }
      // expected: "already known" is fine; the stored hash is what we track.
      await rpc('eth_sendRawTransaction', [record.rawTx]).catch(() => undefined)
      receipt = await this.#poll(rpc, record.txHash)
    }
    if (receipt === undefined) return done('pending')
    await this.#deps.store.setStatus(record.key, receipt.status)
    return done(receipt.status)
  }

  async #poll(rpc: JsonRpc, hash: Hex): Promise<Receipt | undefined> {
    const sleep = this.#deps.sleep ?? defaultSleep
    for (let attempt = 0; attempt < (this.#deps.receiptAttempts ?? 15); attempt += 1) {
      const receipt = await readReceipt(rpc, hash)
      if (receipt !== undefined) return receipt
      await sleep(2000)
    }
    return undefined
  }
}

/** An in-memory store, for tests. The Worker's is the `WalletRelay` Durable Object's SQLite table. */
export const memoryRelayStore = (): RelayStore => {
  const rows = new Map<string, RelayRecord>()
  const onChain = (chain: RelayChain) => [...rows.values()].filter((row) => row.chain === chain)
  return {
    find: async (key) => rows.get(key),
    insert: async (record) => {
      rows.set(record.key, record)
    },
    setStatus: async (key, status) => {
      const row = rows.get(key)
      if (row) rows.set(key, { ...row, status })
    },
    pending: async (chain) => onChain(chain).filter((row) => row.status === 'pending'),
    countSince: async (chain, since, owner) =>
      onChain(chain).filter((row) => row.createdAt >= since && (owner === undefined || row.owner === owner)).length,
    highestNonce: async (chain) => {
      const nonces = onChain(chain).map((row) => row.nonce)
      return nonces.length === 0 ? undefined : Math.max(...nonces)
    },
  }
}

/** The relay's signing account from its private key secret. The key never leaves this account object. */
export const relayAccountFromKey = (privateKey: string): LocalAccount => privateKeyToAccount(toHex(privateKey))
