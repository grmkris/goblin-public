import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { fromDurableObjectSql } from './sql.ts'
import { LedgerStore } from './store.ts'

/** The store methods callable over the Durable Object's RPC: the whole surface, spelled out once. */
export const LEDGER_METHODS = [
  'limits',
  'setLimits',
  'limitViews',
  'lookup',
  'begin',
  'reserve',
  'decide',
  'approval',
  'pendingApprovals',
  'operation',
  'activity',
  'signing',
  'submitted',
  'settle',
  'fail',
  'uncertain',
  'recipients',
  'isKnownRecipient',
  'addRecipient',
  'serviceOverrides',
  'setServiceAllowed',
  'recordPolicyChange',
  'policyChanges',
  'viewState',
  'putViewState',
  'isRevoked',
  'revoke',
] as const satisfies readonly (keyof LedgerStore)[]

type LedgerMethod = (typeof LEDGER_METHODS)[number]

/** The store as seen from a Worker: the same methods, asynchronous. */
export type LedgerApi = {
  [K in LedgerMethod]: LedgerStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
}

type Callable = (...args: unknown[]) => unknown

const Call = Schema.Struct({ method: Schema.String, args: Schema.Array(Schema.Unknown) })
const parseCall = Schema.decodeUnknownOption(Call)
const Answer = Schema.Struct({ result: Schema.Unknown })
const parseAnswer = Schema.decodeUnknownOption(Answer)

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const error = (code: string, message: string, status: number): Response => json({ error: { code, message } }, status)

/** The slice of `DurableObjectState` the ledger uses. */
export interface LedgerHost {
  readonly storage: {
    readonly sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }
    transactionSync<T>(write: () => T): T
  }
}

/**
 * One Durable Object per owner (`idFromName(privyUserId)`): the ledger. Its methods are the `LedgerStore` ones, called
 * as `POST /call {method, args}` so the class stays testable without `cloudflare:workers`; callers use `ledgerClient`.
 * The store is synchronous, so each call is atomic against the others and nothing here awaits.
 */
export class WalletLedger implements DurableObject {
  readonly #table: ReadonlyMap<string, Callable>

  constructor(ctx: LedgerHost) {
    const store = new LedgerStore(fromDurableObjectSql(ctx.storage.sql, (write) => ctx.storage.transactionSync(write)))
    this.#table = new Map(
      LEDGER_METHODS.map((name): [string, Callable] => [
        name,
        // SAFETY: arguments come from `ledgerClient`, typed by LedgerApi; the method is one of the store's own.
        (...args) => (store[name] as Callable).apply(store, args),
      ]),
    )
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/call')
      return error('not_found', 'The ledger answers POST /call only.', 404)
    const call = Option.getOrUndefined(parseCall(await readJson(request)))
    if (call === undefined) return error('bad_call', 'Expected {method, args}.', 400)
    const method = this.#table.get(call.method)
    if (method === undefined) return error('bad_call', `No ledger method ${call.method}.`, 404)
    return json({ result: method(...call.args) })
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    // expected: a body that is not JSON is a bad call, answered as one by the caller.
    return undefined
  }
}

/** A typed client for one owner's ledger. A ledger answer that is not `{result}` throws. */
export function ledgerClient(stub: { fetch(request: Request): Promise<Response> }): LedgerApi {
  const call = async (method: string, args: unknown[]): Promise<unknown> => {
    const response = await stub.fetch(
      new Request('https://ledger.internal/call', {
        method: 'POST',
        body: JSON.stringify({ method, args }),
        headers: { 'content-type': 'application/json' },
      }),
    )
    if (!response.ok) throw new Error(`ledger ${method} failed with ${response.status}`)
    return Option.getOrUndefined(parseAnswer(await response.json()))?.result
  }
  const entries = LEDGER_METHODS.map((name): [string, Callable] => [name, (...args) => call(name, args)])
  // SAFETY: every LEDGER_METHODS entry forwards to the Durable Object method of the same name.
  return Object.fromEntries(entries) as LedgerApi
}
