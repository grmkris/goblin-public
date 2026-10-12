import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import type { FloatSchedule } from '../rails/deps.ts'
import type { LedgerStore } from './store.ts'

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
  'claimChallenge',
  'handOver',
  'challengeCredential',
  'recipients',
  'isKnownRecipient',
  'addRecipient',
  'serviceOverrides',
  'setServiceAllowed',
  'recordPolicyChange',
  'policyChanges',
  'decidePolicyChange',
  'viewState',
  'putViewState',
  'profile',
  'updateProfile',
  'putPreparedAllowance',
  'preparedAllowance',
  'putSignedAllowance',
  'signedAllowances',
  'putPreparedUpgrade',
  'preparedUpgrade',
  'putQuote',
  'getQuote',
  'isRevoked',
  'revoke',
  'floatState',
  'noteFloatNeed',
  'startFloatRun',
  'claimFloat',
  'endFloatRun',
] as const satisfies readonly (keyof LedgerStore)[]

type LedgerMethod = (typeof LEDGER_METHODS)[number]

/** The one ledger call that is the Durable Object's own rather than the store's: it sets the float alarm. */
export const SCHEDULE_FLOAT = 'scheduleFloat'

/** The store as seen from a Worker: the same methods, asynchronous, plus asking for a float check (ADR 0051). */
export type LedgerApi = {
  [K in LedgerMethod]: LedgerStore[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never
} & {
  /** Asks the owner's ledger to check the Tempo float after `delayMs` (its alarm); the earliest request wins. */
  scheduleFloat(request: FloatSchedule): Promise<void>
}

type Callable = (...args: unknown[]) => unknown

const Answer = Schema.Struct({ result: Schema.Unknown })
const parseAnswer = Schema.decodeUnknownOption(Answer)

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
  const names: readonly string[] = [...LEDGER_METHODS, SCHEDULE_FLOAT]
  const entries = names.map((name): [string, Callable] => [name, (...args) => call(name, args)])
  // SAFETY: every entry forwards to the Durable Object method of the same name.
  return Object.fromEntries(entries) as LedgerApi
}
