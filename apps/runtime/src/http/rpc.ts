import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { AppError, failureOf } from './errors.ts'

/**
 * Durable Object RPC result, for the one RPC method left (`deleteAgentData`). Workers RPC keeps plain data but drops
 * error classes, so failures cross as the encoded `AppError` and are rebuilt on the Worker side by `unwrap`.
 */
export type RpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: typeof AppError.Encoded }

export const encodeExit = <A>(exit: Exit.Exit<A, AppError>): RpcResult<A> => {
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  return { ok: false, error: Schema.encodeSync(AppError)(failureOf(exit.cause)) }
}

export const unwrap = <A>(result: RpcResult<A>): A => {
  if (result.ok) return result.value
  throw Schema.decodeUnknownSync(AppError)(result.error)
}
