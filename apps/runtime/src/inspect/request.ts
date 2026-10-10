import { InspectQuery } from '@goblin/contracts/inspect'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'
import { encodeExit } from '../http/rpc.ts'
import type { ExitProgram } from '../runtime/bridge.ts'
import { Inspection } from './service.ts'

const decodeQuery = Schema.decodeUnknownEffect(Schema.fromJsonString(InspectQuery))

/**
 * The agent's own inspection route (ADR 0024): a JSON `InspectQuery` in, an encoded `RpcResult` out. Only the Worker
 * reaches it, from `/mcp` for a client that holds `goblin:inspect`; it renews no authority, needs
 * no plan, and never calls a model.
 */
export async function inspectRequest(request: Request, execute: ExitProgram): Promise<Response> {
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
