import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import {
  Approvals,
  Capabilities,
  Conversations,
  Mcp,
  RoutineRuns,
  attempt,
  attemptSync,
  requireResident,
} from '../services.ts'
import { requireRoutineSession } from '../routines/authority.ts'
import { Conflict } from '../http/errors.ts'
import { objectOrJson } from '../pi/typed-tool.ts'

export const McpCallInput = Schema.Struct({
  serverId: Schema.String,
  name: Schema.String,
  arguments: objectOrJson(Schema.Record(Schema.String, Schema.Json)),
})
export type McpCallInput = typeof McpCallInput.Type
export const modelApprovalId = (session: string, callId: string): string => `mcp:${session}:${callId}`

/** Prepare an exact call in beforeTool; execution repeats this gate because hook failures cannot grant authority. */
export const holdModelCall = (session: string, callId: string, taskId: string, input: McpCallInput) =>
  Effect.gen(function* () {
    const mcp = yield* Mcp
    const policy = mcp.grantPolicy(input.serverId, input.name)
    if (policy?.askFirst !== true) return undefined
    yield* requireResident
    yield* requireRoutineSession(session)
    yield* Conversations.use((registry) => attemptSync(() => registry.requireOpen(session)))
    const scope = (yield* Capabilities).scope(session)
    if (!scope.tool(input.serverId, input.name)) return undefined
    const approvals = yield* Approvals
    const now = yield* Clock.currentTimeMillis
    const row = yield* attempt(() =>
      approvals.hold(
        {
          id: modelApprovalId(session, callId),
          caller: 'model',
          sessionId: session,
          sourceCallId: callId,
          taskId,
          serverId: input.serverId,
          name: input.name,
          arguments: input.arguments,
          endpoint: mcp.manager.server(input.serverId).endpoint,
          grantVersion: policy.version,
        },
        now,
      ),
    )
    if (row.state !== 'pending') return yield* new Conflict({ reason: 'Held call has already been decided' })
    return row
  })

/** End the turn and release a routine's executing slot. The approval itself stays in app-owned storage. */
export const approvalResult = (session: string, callId: string, id: string, input: McpCallInput) =>
  Effect.gen(function* () {
    const runs = yield* RoutineRuns
    const run = runs.session(session)
    if (run !== undefined) {
      const approvals = yield* Approvals
      const now = yield* Clock.currentTimeMillis
      yield* attempt(() =>
        runs.ask(
          session,
          callId,
          [{ id: 'mcp-approval', prompt: `Approve ${input.serverId} · ${input.name}?`, kind: 'text' }],
          approvals.cipher,
          now,
        ),
      )
    } else {
      const conversations = yield* Conversations
      const now = yield* Clock.currentTimeMillis
      if (conversations.kindOf(session) === 'subagent')
        yield* attempt(() => conversations.update(session, { keepOpen: true }, Math.floor(now / 1000)))
    }
    return {
      content: [
        {
          type: 'text',
          text: `Ask first: ${input.serverId} · ${input.name}. Nothing ran. The owner must approve or refuse the exact held arguments in the chat card. Stop and wait. Do not call the tool again; approval dispatches this held call.`,
        },
      ],
      isError: true,
      control: { terminate: true },
      diagnostics: [{ severity: 'info', code: 'approval_required', message: 'Owner approval required for this call.' }],
      details: { kind: 'approval-required', approvalId: id, serverId: input.serverId, name: input.name },
    } satisfies ToolExecutionResult
  })
