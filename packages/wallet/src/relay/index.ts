/**
 * The relay: a gas-paying EOA that sends the owner's EIP-7702 upgrade (a type-4 transaction carrying the owner's signed
 * authorization). The owner never needs gas. The relay holds only gas money, signs only these transactions, and refuses
 * to pay above a per-chain ceiling. The signed bytes are stored before they are broadcast, so a crash retries the
 * exact same transaction, never a second one.
 */
import { recoverAuthorizationAddress } from 'viem/utils'
import { keccak256, type Address, type Hex, type LocalAccount } from 'viem'
import { toAddress, toHex } from '../balances/hex.ts'
import { field, quantity, type JsonRpc } from '../balances/rpc.ts'
import { ARBITRUM, BASE, ETHEREUM, TEMPO } from '../chains/index.ts'
import type { ChainKey, SignedAuthorization } from '../contract/index.ts'

export type RelayChain = Extract<ChainKey, 'base' | 'ethereum' | 'arbitrum' | 'tempo'>

const FACTS = { base: BASE, ethereum: ETHEREUM, arbitrum: ARBITRUM, tempo: TEMPO } as const
const chainFacts = (chain: RelayChain) => ({ id: FACTS[chain].id, delegator: FACTS[chain].delegation.delegator })

export type RelayStatus = 'pending' | 'success' | 'reverted' | 'dropped'

export interface RelayRecord {
  readonly key: string
  readonly chain: RelayChain
  readonly rawTx: Hex
  readonly txHash: Hex
  readonly nonce: number
  readonly status: RelayStatus
}

/** Where signed relay transactions persist (a Durable Object table in the Worker, a Map in tests). */
export interface RelayStore {
  find(key: string): Promise<RelayRecord | undefined>
  insert(record: RelayRecord): Promise<void>
  setStatus(key: string, status: RelayStatus): Promise<void>
  pending(chain: RelayChain): Promise<readonly RelayRecord[]>
}

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

export class RelayError extends Error {
  readonly code: 'bad_request' | 'gas_ceiling' | 'dropped' | 'reverted'
  constructor(code: RelayError['code'], message: string) {
    super(message)
    this.name = 'RelayError'
    this.code = code
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
  readonly account: LocalAccount
  readonly store: RelayStore
  readonly rpc: (chain: RelayChain) => JsonRpc
  readonly ceilings?: Readonly<Record<RelayChain, GasCeiling>>
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
 * Relay sends are serialized by relay address: a nonce read and the signed submission must not interleave, or two
 * upgrades would sign the same nonce.
 */
const queues = new Map<string, Promise<unknown>>()
export const withRelayNonce = <T>(relay: Address, fn: () => Promise<T>): Promise<T> => {
  const key = relay.toLowerCase()
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
    const facts = chainFacts(request.chain)
    const auth = request.authorization
    if (auth.chainId !== facts.id && auth.chainId !== 0)
      throw new RelayError('bad_request', 'the authorization is for another chain')
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

  async #sign(request: UpgradeRequest, rpc: JsonRpc): Promise<RelayRecord> {
    const facts = chainFacts(request.chain)
    const nonce = Number(quantity(await rpc('eth_getTransactionCount', [this.address, 'pending'])))
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
    return { key: request.key, chain: request.chain, rawTx, txHash: keccak256(rawTx), nonce, status: 'pending' }
  }

  /** Sends the owner's upgrade. Idempotent on `request.key`; the transaction is stored before it is broadcast. */
  upgrade(request: UpgradeRequest): Promise<RelayResult> {
    return withRelayNonce(this.address, async () => {
      await this.#validate(request)
      const rpc = this.#deps.rpc(request.chain)
      let record = await this.#deps.store.find(request.key)
      if (record === undefined) {
        await this.#reconcilePending(request.chain)
        record = await this.#sign(request, rpc)
        await this.#deps.store.insert(record)
      }
      return this.#settle(record, rpc)
    })
  }

  /** Reconciles every stored pending transaction on a chain; safe to run on a timer. */
  reconcile(chain: RelayChain): Promise<void> {
    return withRelayNonce(this.address, () => this.#reconcilePending(chain))
  }

  async #reconcilePending(chain: RelayChain): Promise<void> {
    const rpc = this.#deps.rpc(chain)
    for (const record of await this.#deps.store.pending(chain)) await this.#settle(record, rpc)
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

/** An in-memory store, for tests and local runs. */
export const memoryRelayStore = (): RelayStore => {
  const rows = new Map<string, RelayRecord>()
  return {
    find: async (key) => rows.get(key),
    insert: async (record) => {
      rows.set(record.key, record)
    },
    setStatus: async (key, status) => {
      const row = rows.get(key)
      if (row) rows.set(key, { ...row, status })
    },
    pending: async (chain) => [...rows.values()].filter((row) => row.chain === chain && row.status === 'pending'),
  }
}
