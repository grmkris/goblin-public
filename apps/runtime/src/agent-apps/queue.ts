import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { KeyedLock } from '../observability/lock.ts'

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
const appKey = (app: string): string => `agent-app:${app}`

/** `effect` holding `app`'s lock, for a program already in the runtime. */
export const withAppLock =
  (app: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | KeyedLock> =>
    KeyedLock.use((locks) => locks.withLock(appKey(app))(effect))

/** Carries what locked work threw out through the runtime, so the caller gets it back as it was thrown. */
class LockedWorkFailed extends Schema.TaggedError<LockedWorkFailed>()('LockedWorkFailed', { cause: Schema.Defect() }) {}

/** The app lock for the engine's Promise callers, taken in the runtime through `run`; `work`'s failure comes back as thrown. */
export function appLock(run: AppRunner): AppLock {
  return async (app, work) => {
    const locked = Effect.tryPromise({ try: work, catch: (cause) => new LockedWorkFailed({ cause }) })
    const exit = await run(Effect.exit(withAppLock(app)(locked)))
    if (Exit.isSuccess(exit)) return exit.value
    const failure = Cause.squash(exit.cause)
    throw failure instanceof LockedWorkFailed ? failure.cause : failure
  }
}

/** An app's own code failed or broke a rule: the message is for the agent, with the app's stack when it has one. */
export class AppCodeError extends Error {
  override readonly name = 'AppCodeError'
}

/** A failure as one line for the agent: an app error's text, or a tagged goblin error with its fields. */
export function problemText(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null && '_tag' in cause) {
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
