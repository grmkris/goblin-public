import type { JsonRpc } from '@goblin/wallet/balances'
import { chainByKey } from '@goblin/wallet/chains'
import {
  RelayError,
  RelaySender,
  relayAccountFromKey,
  type RelayChain,
  type RelayRecord,
  type RelayResult,
  type RelayStatus,
  type RelayStore,
  type UpgradeRequest,
} from '@goblin/wallet/relay'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { WalletEnv } from '../env.ts'
import { fromDurableObjectSql, type Sql } from '../ledger/sql.ts'
import { rpcFromEnv } from './rpc.ts'

const SCHEMA = `CREATE TABLE IF NOT EXISTS relay_transactions (
  key TEXT PRIMARY KEY, chain TEXT NOT NULL, owner TEXT NOT NULL, raw_tx TEXT NOT NULL, tx_hash TEXT NOT NULL,
  nonce INTEGER NOT NULL, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`

interface Row {
  readonly key: string
  readonly chain: string
  readonly owner: string
  readonly raw_tx: string
  readonly tx_hash: string
  readonly nonce: number
  readonly status: string
  readonly created_at_ms: number
}

const RelayRow = Schema.Struct({
  key: Schema.String,
  chain: Schema.Literals(['base', 'ethereum', 'arbitrum', 'tempo']),
  owner: Schema.String,
  rawTx: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]+$/u)),
  txHash: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{64}$/u)),
  nonce: Schema.Int,
  status: Schema.Literals(['pending', 'success', 'reverted', 'dropped']),
  createdAt: Schema.Int,
})
const decodeRow = Schema.decodeUnknownSync(RelayRow)

const recordOf = (row: Row): RelayRecord => {
  const decoded = decodeRow({ ...row, rawTx: row.raw_tx, txHash: row.tx_hash, createdAt: row.created_at_ms })
  // SAFETY: the schema checked both are 0x-hex strings.
  return { ...decoded, rawTx: decoded.rawTx as `0x${string}`, txHash: decoded.txHash as `0x${string}` }
}

/** The relay's transactions in the Durable Object's SQLite: signed bytes land here before they are broadcast. */
export const sqlRelayStore = (sql: Sql): RelayStore => {
  sql.run(SCHEMA)
  const one = (key: string) => sql.all<Row>('SELECT * FROM relay_transactions WHERE key = ?', key)[0]
  return {
    find: async (key) => {
      const row = one(key)
      return row === undefined ? undefined : recordOf(row)
    },
    insert: async (record) => {
      sql.run(
        `INSERT OR REPLACE INTO relay_transactions (key, chain, owner, raw_tx, tx_hash, nonce, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        record.key,
        record.chain,
        record.owner,
        record.rawTx,
        record.txHash,
        record.nonce,
        record.status,
        record.createdAt,
      )
    },
    setStatus: async (key, status: RelayStatus) => {
      sql.run('UPDATE relay_transactions SET status = ? WHERE key = ?', status, key)
    },
    pending: async (chain) =>
      sql
        .all<Row>("SELECT * FROM relay_transactions WHERE chain = ? AND status = 'pending' ORDER BY nonce", chain)
        .map(recordOf),
    countSince: async (chain, since, owner) =>
      sql.all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM relay_transactions WHERE chain = ? AND created_at_ms >= ? AND (? IS NULL OR owner = ?)',
        chain,
        since,
        owner ?? null,
        owner ?? null,
      )[0]?.n ?? 0,
    highestNonce: async (chain) =>
      sql.all<{ n: number | null }>('SELECT MAX(nonce) AS n FROM relay_transactions WHERE chain = ?', chain)[0]?.n ??
      undefined,
  }
}

const Upgrade = Schema.Struct({
  key: Schema.String.check(Schema.isMaxLength(200)),
  chain: Schema.Literals(['base', 'ethereum', 'arbitrum', 'tempo']),
  owner: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)),
  authorization: Schema.Struct({
    address: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{40}$/u)),
    chainId: Schema.Int,
    nonce: Schema.Int,
    r: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{1,64}$/u)),
    s: Schema.String.check(Schema.isPattern(/^0x[0-9a-fA-F]{1,64}$/u)),
    yParity: Schema.Int,
  }),
})
const parseUpgrade = Schema.decodeUnknownOption(Upgrade)

const Answer = Schema.Union([
  Schema.Struct({
    result: Schema.Struct({
      txHash: Schema.String,
      status: Schema.Literals(['pending', 'success', 'reverted', 'dropped']),
      nonce: Schema.Int,
    }),
  }),
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
])
const parseAnswer = Schema.decodeUnknownOption(Answer)

async function readJson(message: Request | Response): Promise<unknown> {
  try {
    return await message.json()
  } catch {
    // expected: a body that is not JSON is malformed, and the schema decode right after reports it as such.
    return undefined
  }
}

const RELAY_CODES = new Set<string>(['bad_request', 'gas_ceiling', 'dropped', 'reverted', 'busy', 'quota'])
const isRelayCode = (code: string): code is RelayError['code'] => RELAY_CODES.has(code)

/** The slice of `DurableObjectState` the relay uses. */
export interface RelayHost {
  readonly storage: {
    readonly sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }
    transactionSync<T>(write: () => T): T
  }
}

export type RelayEnv = Pick<WalletEnv, 'RELAY_PRIVATE_KEY' | 'RPC_URLS' | 'WALLET_LIVE'>

export interface RelayObjectOptions {
  readonly rpcFor?: (chain: RelayChain) => JsonRpc
  readonly sleep?: (ms: number) => Promise<void>
  readonly receiptAttempts?: number
  readonly now?: () => number
}

/**
 * One Durable Object per chain and relay address (`relayObjectName`): the only place that relay key signs on that
 * chain. Its SQLite holds every signed transaction and the daily quota; `RelaySender`'s queue, which serializes nonce
 * reads and submissions, is global because this object is. Answers `POST /upgrade` so it stays testable without
 * `cloudflare:workers`; callers use `relayClient`. A relay failure is an answer (`{error}`), never a thrown 500.
 */
export class RelayObject implements DurableObject {
  readonly #sender: RelaySender | undefined

  constructor(ctx: RelayHost, env: RelayEnv, options: RelayObjectOptions = {}) {
    const store = sqlRelayStore(fromDurableObjectSql(ctx.storage.sql, (write) => ctx.storage.transactionSync(write)))
    const live = env.WALLET_LIVE === '1'
    this.#sender =
      env.RELAY_PRIVATE_KEY === ''
        ? undefined
        : new RelaySender({
            live,
            account: relayAccountFromKey(env.RELAY_PRIVATE_KEY),
            store,
            rpc: options.rpcFor ?? rpcFromEnv(env.RPC_URLS, live),
            ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
            ...(options.receiptAttempts === undefined ? {} : { receiptAttempts: options.receiptAttempts }),
            ...(options.now === undefined ? {} : { now: options.now }),
          })
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/upgrade')
      return Response.json({ error: { code: 'bad_request', message: 'The relay answers POST /upgrade only.' } })
    const upgrade = Option.getOrUndefined(parseUpgrade(await readJson(request)))
    if (upgrade === undefined) return Response.json({ error: { code: 'bad_request', message: 'Malformed upgrade.' } })
    if (this.#sender === undefined)
      return Response.json({ error: { code: 'bad_request', message: 'No relay key is configured.' } })
    try {
      const result = await this.#sender.upgrade(upgrade)
      return Response.json({ result })
    } catch (error) {
      if (error instanceof RelayError) return Response.json({ error: { code: error.code, message: error.message } })
      throw error
    }
  }
}

/** The deployed class. Cloudflare passes `(state, env)`; the real clock and RPCs are the defaults. */
export class WalletRelay extends RelayObject {}

/** The Durable Object name of a relay: one per network chain id and relay address. */
export const relayObjectName = (chainId: number, relay: string): string => `${chainId}:${relay.toLowerCase()}`

/** The relay as the rails see it: `upgrade` forwarded to the chain's `WalletRelay`, its refusals re-raised. */
export const relayClient = (
  stubFor: (chain: RelayChain) => { fetch(request: Request): Promise<Response> },
): { upgrade(request: UpgradeRequest): Promise<RelayResult> } => ({
  upgrade: async (upgrade) => {
    const response = await stubFor(upgrade.chain).fetch(
      new Request('https://relay.internal/upgrade', {
        method: 'POST',
        body: JSON.stringify(upgrade),
        headers: { 'content-type': 'application/json' },
      }),
    )
    const answer = Option.getOrUndefined(parseAnswer(await readJson(response)))
    if (answer === undefined) throw new Error(`relay answered ${response.status}`)
    if ('error' in answer)
      throw new RelayError(isRelayCode(answer.error.code) ? answer.error.code : 'bad_request', answer.error.message)
    // SAFETY: the schema checked txHash is a string; the relay only ever answers the hash it computed.
    return { ...answer.result, txHash: answer.result.txHash as `0x${string}` }
  },
})

/** Which `WalletRelay` serves a chain for this deployment's relay key and network. */
export const relayStubs = (env: WalletEnv, relayAddress: string) => {
  const live = env.WALLET_LIVE === '1'
  return (chain: RelayChain) => env.RELAY.getByName(relayObjectName(chainByKey(chain, live).id, relayAddress))
}
