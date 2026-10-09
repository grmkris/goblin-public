import * as Cause from 'effect/Cause'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { KeyedLock } from '../observability/lock.ts'
import { IsolateTimeout } from './isolates.ts'

/**
 * Runs a program in the agent's runtime with no plan check (the bridge's `local`). The engine lives outside the
 * runtime (Pi's tools, job alarms, an isolate's calls reach it as Promises), so this is how it takes an app's lock.
 */
export type AppRunner = <A>(program: Effect.Effect<A, never, KeyedLock>) => Promise<A>

/**
 * Runs `work` holding `app`'s lock: one app's state changes (an action's commit, an activation, a rollback, its
 * deletion) one at a time in arrival order, so each reads the revision the previous one wrote. Reads and `prepare`
 * do not take it.
 */
export type AppLock = <T>(app: string, work: () => Promise<T>) => Promise<T>

/** The KeyedLock key of an app's state changes, the same inside the runtime and through `AppRunner`. */
export const appKey = (app: string): string => `agent-app:${app}`

/** `effect` holding `app`'s lock, for a program already in the runtime. */
export const withAppLock =
  (app: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | KeyedLock> =>
    KeyedLock.use((locks) => locks.withLock(appKey(app))(effect))

/** Carries what Promise work threw through an Effect, so its caller gets it back as it was thrown. */
class Thrown extends Schema.TaggedError<Thrown>()('Thrown', { cause: Schema.Defect() }) {}

/** Promise work as an Effect whose failure is `Thrown`, carrying what the work threw. */
export const promised = <A>(work: () => Promise<A>): Effect.Effect<A, Thrown> =>
  Effect.tryPromise({ try: work, catch: (cause) => new Thrown({ cause }) })

/** What an exit failed with, as it was first thrown: for code that answers a Promise. */
export const thrownOf = (cause: Cause.Cause<unknown>): unknown => {
  const failure = Cause.squash(cause)
  return failure instanceof Thrown ? failure.cause : failure
}

/** The app lock for the engine's Promise callers, taken in the runtime through `run`; `work`'s failure comes back as thrown. */
export function appLock(run: AppRunner): AppLock {
  return async (app, work) => {
    const exit = await run(Effect.exit(withAppLock(app)(promised(work))))
    if (Exit.isSuccess(exit)) return exit.value
    throw thrownOf(exit.cause)
  }
}

/** An app's own code failed or broke a rule: the message is for the agent, with the app's stack when it has one. */
export class AppCodeError extends Data.TaggedError('AppCodeError')<{ readonly message: string }> {
  constructor(message: string) {
    super({ message })
  }
}

/** A failure as one line for the agent: an app error's text, or a tagged goblin error with its fields. */
export function problemText(cause: unknown): string {
  const text = cause instanceof AppCodeError || cause instanceof IsolateTimeout
  if (!text && typeof cause === 'object' && cause !== null && '_tag' in cause) {
    const fields = Object.entries(cause)
      .filter(([key]) => key !== '_tag' && key !== 'stack' && key !== 'message')
      .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    return [String(cause._tag), ...fields].join(' — ')
  }
  return cause instanceof Error && cause.message !== '' ? cause.message : 'The call failed.'
}

/**
 * A goblin failure handed to code in an isolate: an app's power or a script's file call refused. Workers RPC carries
 * only an error's message across, so the message is the failure as one readable line; the failure stays its cause.
 */
export class IsolateRefusal extends Schema.TaggedError<IsolateRefusal>()('IsolateRefusal', {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** `cause` as the refusal the isolate's code reads. */
export const refusalOf = (cause: unknown): IsolateRefusal => new IsolateRefusal({ message: problemText(cause), cause })
