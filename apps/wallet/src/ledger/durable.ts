import { UsdAmount } from '@goblin/wallet/contract'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { WalletEnv } from '../env.ts'
import { floatRunnerFor } from '../owner-deps.ts'
import type { FloatSchedule } from '../rails/deps.ts'
import { LEDGER_METHODS, type LedgerApi, SCHEDULE_FLOAT } from './client.ts'
import { fromDurableObjectSql } from './sql.ts'
import { LedgerStore } from './store.ts'

export { LEDGER_METHODS, type LedgerApi, ledgerClient } from './client.ts'

/** One run of the owner's float alarm over its own ledger; answers when to run again after a failure. */
export type FloatRunner = (ledger: LedgerApi) => Promise<{ retryInMs?: number }>

type Callable = (...args: unknown[]) => unknown

const Call = Schema.Struct({ method: Schema.String, args: Schema.Array(Schema.Unknown) })
const parseCall = Schema.decodeUnknownOption(Call)
const DAY_MS = 86_400_000
const Schedule = Schema.Struct({
  delayMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: DAY_MS })),
  need: Schema.optional(UsdAmount),
})
const parseSchedule = Schema.decodeUnknownOption(Schedule)

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const error = (code: string, message: string, status: number): Response => json({ error: { code, message } }, status)

/** The slice of `DurableObjectState` the ledger uses. */
export interface LedgerHost {
  readonly storage: {
    readonly sql: { exec(query: string, ...bindings: unknown[]): { toArray(): unknown[] } }
    transactionSync<T>(write: () => T): T
    /** The object's one alarm (the float's); hosts that run no float, such as tests, leave these out. */
    getAlarm?(): Promise<number | null>
    setAlarm?(scheduledTime: number): Promise<void>
  }
}

/**
 * One Durable Object per owner (`idFromName(privyUserId)`): the ledger. Its methods are the `LedgerStore` ones, called
 * as `POST /call {method, args}` so the class stays testable without `cloudflare:workers`; callers use `ledgerClient`.
 * The store is synchronous, so each call is atomic against the others. One more call, `scheduleFloat`, sets the
 * object's alarm, whose run keeps the agent's Tempo float topped up (ADR 0051) through the same store.
 */
export class LedgerObject implements DurableObject {
  readonly #table: ReadonlyMap<string, Callable>
  readonly #store: LedgerStore
  readonly #host: LedgerHost
  readonly #now: () => number
  readonly #runFloat: FloatRunner | undefined

  constructor(ctx: LedgerHost, now: () => number, runFloat?: FloatRunner) {
    const store = new LedgerStore(
      fromDurableObjectSql(ctx.storage.sql, (write) => ctx.storage.transactionSync(write)),
      now,
    )
    this.#store = store
    this.#host = ctx
    this.#now = now
    this.#runFloat = runFloat
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
    if (call.method === SCHEDULE_FLOAT) {
      const schedule = Option.getOrUndefined(parseSchedule(call.args[0]))
      if (schedule === undefined) return error('bad_call', 'Expected {delayMs, need?}.', 400)
      await this.#schedule(schedule)
      return json({ result: null })
    }
    const method = this.#table.get(call.method)
    if (method === undefined) return error('bad_call', `No ledger method ${call.method}.`, 404)
    return json({ result: method(...call.args) })
  }

  /** The float's alarm: one refill run over this ledger. A run that failed asks for another, bounded by the ledger. */
  async alarm(): Promise<void> {
    if (this.#runFloat === undefined) return
    let next: { retryInMs?: number }
    try {
      next = await this.#runFloat(this.#local())
    } catch {
      // expected: a run records its own refill's outcome; a defect is not retried, so it never sends twice.
      return
    }
    if (next.retryInMs !== undefined) await this.#schedule({ delayMs: next.retryInMs })
  }

  /** Notes the payment to fit, then sets the alarm unless an earlier one is already set. */
  async #schedule(request: FloatSchedule): Promise<void> {
    if (request.need !== undefined) this.#store.noteFloatNeed(request.need)
    const { storage } = this.#host
    if (storage.getAlarm === undefined || storage.setAlarm === undefined) return
    const at = this.#now() + request.delayMs
    const current = await storage.getAlarm()
    if (current === null || current > at) await storage.setAlarm(at)
  }

  /** This ledger as its own client, for the alarm's run: the same methods, called in place. */
  #local(): LedgerApi {
    const entries = [...this.#table].map(([name, method]): [string, Callable] => [
      name,
      async (...args) => method(...args),
    ])
    const schedule = (request: FloatSchedule) => this.#schedule(request)
    // SAFETY: the table holds every LEDGER_METHODS entry of the store; scheduleFloat is the object's own.
    return { ...Object.fromEntries(entries), [SCHEDULE_FLOAT]: schedule } as LedgerApi
  }
}

/**
 * The deployed class. Cloudflare passes `(state, env)`, so the clock is not a constructor argument here; with an env it
 * runs the float's refills, and without one (tests) it is the plain ledger.
 */
export class WalletLedger extends LedgerObject {
  constructor(ctx: LedgerHost, env?: WalletEnv) {
    super(ctx, Date.now, env === undefined ? undefined : floatRunnerFor(env))
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
