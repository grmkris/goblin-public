import type * as Effect from 'effect/Effect'
import type * as Exit from 'effect/Exit'
import { HomeEdit } from '@goblin/contracts'
import { ownerRequest } from '../agent-program.ts'
import { readJson } from '../http/body.ts'
import { NotFound, type AppError } from '../http/errors.ts'
import { failureResponse } from '../http/respond.ts'
import { encodeExit, unwrap } from '../http/rpc.ts'
import type { AgentServices } from '../services.ts'
import { editHomeLayout, readHomeLayout } from './program.ts'

type Execute = <A>(program: Effect.Effect<A, AppError, AgentServices>) => Promise<Exit.Exit<A, AppError>>
/** Forwarded only by the authenticated owner Worker; presentation edits use the same service as Pi. */
export async function homeRequest(request: Request, execute: Execute): Promise<Response> {
  try {
    if (request.method === 'GET') return Response.json(unwrap(encodeExit(await execute(ownerRequest(readHomeLayout)))))
    if (request.method !== 'POST') throw new NotFound({ what: 'home route' })
    const input = await readJson(request, HomeEdit)
    const result = unwrap(encodeExit(await execute(ownerRequest(editHomeLayout(input, 'owner')))))
    return Response.json(result, { status: result.kind === 'stale' ? 409 : 200 })
  } catch (cause) {
    return failureResponse(cause, '/home', 'home')
  }
}
