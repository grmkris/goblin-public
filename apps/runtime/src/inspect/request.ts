import { InspectQuery, OperatorReadInput } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import { type AppError, InvalidInput } from '../http/errors.ts'
import { encodeExit } from '../http/rpc.ts'
import { type AgentServices, Inspect, OperatorLog, attempt, attemptSync } from '../services.ts'

type Execute = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<Exit.Exit<A, AppError>>

const decodeQuery = Schema.decodeUnknownEffect(Schema.fromJsonString(InspectQuery))
const decodeRead = Schema.decodeUnknownEffect(Schema.fromJsonString(OperatorReadInput))
const methodNotAllowed = () => Response.json({ error: 'MethodNotAllowed' }, { status: 405 })
const DEFAULT_READS = 20
const MAX_READS = 100

/**
 * The agent's own inspection route (ADR 0024): a JSON `InspectQuery` in, an encoded `RpcResult` out. Only the Worker
 * reaches it, from the inspection MCP endpoints after they have authorized the caller; it renews no authority, needs
 * no plan, and never calls a model.
 */
export async function inspectRequest(request: Request, execute: Execute): Promise<Response> {
  if (request.method !== 'POST') return methodNotAllowed()
  const body = await request.text()
  const exit = await execute(
    decodeQuery(body).pipe(
      Effect.mapError(() => new InvalidInput({ reason: 'inspect query' })),
      Effect.flatMap((query) => Inspect.use((inspector) => attempt(() => inspector.run(query)))),
    ),
  )
  return Response.json(encodeExit(exit))
}

/**
 * The owner's record of their operator reads: POST records one (the Worker does, before each read), GET lists the
 * newest. Like `/inspect`, only the Worker reaches it.
 */
export async function operatorReadsRequest(request: Request, url: URL, execute: Execute): Promise<Response> {
  if (request.method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || DEFAULT_READS, 1), MAX_READS)
    return Response.json(encodeExit(await execute(OperatorLog.use((log) => attemptSync(() => log.recent(limit))))))
  }
  if (request.method !== 'POST') return methodNotAllowed()
  const body = await request.text()
  const exit = await execute(
    decodeRead(body).pipe(
      Effect.mapError(() => new InvalidInput({ reason: 'operator read' })),
      Effect.flatMap((read) => OperatorLog.use((log) => attemptSync(() => log.record(read)))),
    ),
  )
  return Response.json(encodeExit(exit))
}
