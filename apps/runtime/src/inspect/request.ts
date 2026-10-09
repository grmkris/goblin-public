import { InspectQuery } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { type AppError, InvalidInput } from '../http/errors.ts'
import { encodeExit } from '../http/rpc.ts'
import { Inspection } from './service.ts'

/** Runs an inspection program to its exit; it needs nothing but `Inspection`. */
type Execute = <A>(program: Effect.Effect<A, AppError, Inspection>) => Promise<Exit.Exit<A, AppError>>

const decodeQuery = Schema.decodeUnknownEffect(Schema.fromJsonString(InspectQuery))

/**
 * The agent's own inspection route (ADR 0024): a JSON `InspectQuery` in, an encoded `RpcResult` out. Only the Worker
 * reaches it, from `/mcp` for a client that holds `goblin:inspect`; it renews no authority, needs
 * no plan, and never calls a model.
 */
export async function inspectRequest(request: Request, execute: Execute): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'MethodNotAllowed' }, { status: 405 })
  const body = await request.text()
  const exit = await execute(
    decodeQuery(body).pipe(
      Effect.mapError(() => new InvalidInput({ reason: 'inspect query' })),
      Effect.flatMap((query) => Inspection.use((inspection) => inspection.run(query))),
    ),
  )
  return Response.json(encodeExit(exit))
}
