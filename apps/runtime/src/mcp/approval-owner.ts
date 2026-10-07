import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { Approvals, Mcp, RoutineRuns, attempt, attemptSync } from '../services.ts'
import { unwrap } from '../http/rpc.ts'
import type { RpcResult } from '../http/rpc.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
import type { RoutineRunner } from '../routines/runner.ts'
import { decideApproval } from './approval-decision.ts'

export const setAskFirst = (serverId: string, name: string, enabled: boolean) =>
  Mcp.use((mcp) =>
    attemptSync(() => {
      mcp.setAskFirst(serverId, name, enabled)
      return mcp.grants()
    }),
  )
export const approvalView = (id: string) =>
  Effect.gen(function* () {
    const store = yield* Approvals
    const now = yield* Clock.currentTimeMillis
    return yield* attempt(() => store.view(id, now))
  })

export const ownerApprovalDecision = (
  id: string,
  allowed: boolean,
  input: {
    readonly run: RunProgram
    readonly routines: RoutineRunner
    readonly submit: (session: string, text: string, operationId: string) => Promise<RpcResult<unknown>>
  },
) =>
  decideApproval({
    id,
    allowed,
    run: input.run,
    continue: async (session, text, operationId) => {
      const record = await input.run(RoutineRuns.useSync((store) => store.session(session)))
      if (record?.state === 'running') return input.routines.start(record, { text, operationId })
      return unwrap(await input.submit(session, text, operationId))
    },
  })

/** A direct owner read, with the same exact App resource grant as the existing bridge. */
export const ownerResource = (serverId: string, uri: string, caller: 'human' | 'app') =>
  Mcp.use((mcp) =>
    attempt(() =>
      caller === 'app' ? mcp.manager.readAppResource(serverId, uri) : mcp.manager.readResource(serverId, uri),
    ),
  )
