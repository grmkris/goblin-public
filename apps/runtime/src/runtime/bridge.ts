import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as ManagedRuntime from 'effect/ManagedRuntime'
import { Entitlements } from '../billing/gates.ts'
import { type AppError, toAppError } from '../http/errors.ts'
import { encodeExit, unwrap } from '../http/rpc.ts'
import { type AgentServices, Mcp, attempt } from '../services.ts'
import { type Instrument, uninstrumented } from './instrument.ts'

type Runtime = ManagedRuntime.ManagedRuntime<AgentServices, never>
type Program<A> = Effect.Effect<A, AppError, AgentServices>

/** Runs a program to its value, or rejects with its `AppError` (decoded, as the Worker would see it). */
export type RunProgram = <A>(program: Program<A>) => Promise<A>
/** Runs a program to its exit; a runtime that failed to build is an `AppError` exit too. */
export type ExitProgram = <A>(program: Program<A>) => Promise<Exit.Exit<A, AppError>>

export interface Bridge {
  /** Checks the account's plan (`Entitlements.require()`), then runs the program. */
  readonly run: RunProgram
  /** Runs the program with no plan check: the ledger, budget records, routine gates and diagnose. */
  readonly local: RunProgram
  /** Runs the program to its exit, for the RPC methods that encode it. */
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
      const result = await exit(
        Effect.andThen(checkPlan ? Entitlements.use((plans) => plans.require()) : Effect.void, program),
      )
      if (Exit.isSuccess(result)) return result.value
      return unwrap(encodeExit(result))
    }
  return { run: settle(true), local: settle(false), exit }
}

/** Closes a built runtime's MCP connections, then disposes it. One that never finished building has nothing to close. */
export async function closeRuntime(runtime: Promise<Runtime>): Promise<void> {
  const services = await runtime.catch(() => undefined)
  await services?.runPromise(Mcp.use((mcp) => attempt(() => mcp.manager.closeAll()))).catch(() => undefined)
  await services?.dispose()
}
