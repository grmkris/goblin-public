import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { AppError, toAppError } from './errors.ts'

/**
 * Durable Object RPC result. Workers RPC keeps plain data but drops error classes, so failures cross as the encoded
 * `AppError` and are rebuilt on the Worker side by `unwrap`.
 */
export type RpcResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: typeof AppError.Encoded }

export const encodeExit = <A>(exit: Exit.Exit<A, AppError>): RpcResult<A> => {
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const failure = Option.getOrElse(Cause.findErrorOption(exit.cause), () => toAppError(Cause.squash(exit.cause)))
  return { ok: false, error: Schema.encodeSync(AppError)(failure) }
}

export const unwrap = <A>(result: RpcResult<A>): A => {
  if (result.ok) return result.value
  throw Schema.decodeUnknownSync(AppError)(result.error)
}
