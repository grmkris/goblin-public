import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Chats, Conversations } from '../chats/service.ts'
import { Setups } from '../setup/service.ts'
import { requireRoutineSession } from '../routines/authority.ts'
import { RoutineRuns } from '../routines/service.ts'
import { Conflict, NotFound } from '../http/errors.ts'
import { objectOrJson } from '../pi/typed-tool.ts'
import { named } from './labels.ts'
import { Approvals, McpConnections, McpGrants, McpServers, requireResident } from './service.ts'

export const McpCallInput = Schema.Struct({
  connectionId: Schema.String,
  name: Schema.String,
  arguments: objectOrJson(Schema.Record(Schema.String, Schema.Json)),
})
export type McpCallInput = typeof McpCallInput.Type
export const modelApprovalId = (session: string, callId: string): string => `mcp:${session}:${callId}`

/** Prepare an exact call in beforeTool; execution repeats this gate because hook failures cannot grant authority. */
export const holdModelCall = (session: string, callId: string, taskId: string, input: McpCallInput) =>
  Effect.gen(function* () {
    const policy = yield* (yield* McpGrants).policy(input.connectionId, input.name)
    if (Option.isNone(policy) || !policy.value.askFirst) return undefined
    yield* requireResident
    yield* requireRoutineSession(session)
    const chat = yield* (yield* Chats).chatOf(session)
    if (Option.isNone(chat)) return yield* new NotFound({ what: 'chat' })
    yield* (yield* Conversations).requireActing(chat.value)
    const scope = yield* (yield* Setups).scope(session)
    if (!scope.tool(input.connectionId, input.name)) return undefined
    const server = yield* (yield* McpConnections).server(input.connectionId)
    const row = yield* (yield* Approvals).hold({
      id: modelApprovalId(session, callId),
      caller: 'model',
      sessionId: session,
      sourceCallId: callId,
      taskId,
      connectionId: input.connectionId,
      name: input.name,
      arguments: input.arguments,
      endpoint: server.endpoint,
      grantVersion: policy.value.version,
    })
    if (row.state !== 'pending') return yield* new Conflict({ reason: 'Held call has already been decided' })
    return row
  })

/**
 * The turn ends waiting on the owner: a routine run asks them `prompt` and releases its executing slot; a subagent's
 * chat stays open for the answer.
 */
export const waitOnOwner = (session: string, callId: string, question: string, prompt: string) =>
  Effect.gen(function* () {
    const runs = yield* RoutineRuns
    const run = yield* runs.session(session)
    if (run !== undefined) {
      const { cipher } = yield* Approvals
      const now = yield* Clock.currentTimeMillis
      yield* runs.ask(session, callId, [{ id: question, prompt, kind: 'text' }], cipher, now)
      return
    }
    const conversations = yield* Conversations
    const chat = yield* (yield* Chats).chatOf(session)
    if (Option.isSome(chat) && (yield* conversations.kindOf(chat.value)) === 'subagent')
      yield* conversations.update(chat.value, { keepOpen: true })
  })

/** End the turn and release a routine's executing slot. The approval itself stays in app-owned storage. */
export const approvalResult = (session: string, callId: string, id: string, input: McpCallInput) =>
  Effect.gen(function* () {
    const connection = named(yield* (yield* McpServers).labels(), input.connectionId)
    yield* waitOnOwner(session, callId, 'mcp-approval', `Approve ${connection} · ${input.name}?`)
    return {
      content: [
        {
          type: 'text',
          text: `Ask first: ${connection} · ${input.name}. Nothing ran. The owner must approve or refuse the exact held arguments in the chat card. Stop and wait. Do not call the tool again; approval dispatches this held call.`,
        },
      ],
      isError: true,
      control: { terminate: true },
      diagnostics: [{ severity: 'info', code: 'approval_required', message: 'Owner approval required for this call.' }],
      details: { kind: 'approval-required', approvalId: id, connectionId: input.connectionId, name: input.name },
    } satisfies ToolExecutionResult
  })
