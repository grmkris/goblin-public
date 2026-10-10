import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as ManagedRuntime from 'effect/ManagedRuntime'
import { requirePlan } from '../billing/gates.ts'
import { type AppError, failureOf, toAppError } from '../http/errors.ts'
import type { AgentServices } from '../layers/index.ts'
import { type Instrument, uninstrumented } from './instrument.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>
type Program<A> = Effect.Effect<A, AppError, AgentServices>

/** Runs a program to its value, or rejects with the `AppError` it failed with (a defect is `Internal`, reported). */
export type RunProgram = <A>(program: Program<A>) => Promise<A>
/** Runs a program to its exit; a runtime that failed to build is an `AppError` exit too. */
type ExitProgram = <A>(program: Program<A>) => Promise<Exit.Exit<A, AppError>>

export interface Bridge {
  /** Checks the account's plan (`requirePlan()`), then runs the program. */
  readonly run: RunProgram
  /** Runs the program with no plan check: the ledger, budget records, routine gates and diagnose. */
  readonly local: RunProgram
  /** Runs the program to its exit: the agent's typed APIs answer a failure in their envelope. */
  readonly exit: ExitProgram
}

/**
 * The one place the Durable Object runs its Effect programs: on the runtime `getRuntime` gives (built lazily, once per
 * object), each wrapped in `options.instrument`. Never call `run` or `local` inside an Effect: compose the program.
 */
export function makeBridge(
  getRuntime: () => Promise<Runtime>,
  options: { readonly instrument?: Instrument } = {},
): Bridge {
  const instrument = options.instrument ?? uninstrumented
  const exit: ExitProgram = async (program) => {
    try {
      return await (await getRuntime()).runPromiseExit(instrument(program))
    } catch (cause) {
      return Exit.fail(toAppError(cause))
    }
  }
  const settle =
    (checkPlan: boolean): RunProgram =>
    async (program) => {
      const result = await exit(Effect.andThen(checkPlan ? requirePlan() : Effect.void, program))
      if (Exit.isSuccess(result)) return result.value
      throw failureOf(result.cause)
    }
  return { run: settle(true), local: settle(false), exit }
}

/** Builds the runtime's layers before handing it out, so a failed start rejects (and the next caller starts again). */
export async function openRuntime(runtime: Runtime): Promise<Runtime> {
  await runtime.context()
  return runtime
}
