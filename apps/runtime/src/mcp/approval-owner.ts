import * as Effect from 'effect/Effect'
import { type AppError, NotFound } from '../http/errors.ts'
import { type RpcResult, unwrap } from '../http/rpc.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
import type { RoutineRunner } from '../routines/runner.ts'
import type { ApprovalView } from '@goblin/contracts'
import { submitOwner } from '../agent-program.ts'
import { Entitlements } from '../billing/gates.ts'
import { AgentInput } from '../runtime/input.ts'
import {
  Apps,
  Approvals as LegacyApprovals,
  Budget,
  Capabilities,
  Chats,
  Conversations,
  Files,
  Invocations,
  Mcp,
  Personas,
  RoutineRuns,
  Skills,
  attempt,
} from '../services.ts'
import { decideApproval } from './approval-decision.ts'
import { Approvals, McpConnections, McpGrants, Resident } from './service.ts'

export const setAskFirst = (serverId: string, name: string, enabled: boolean) =>
  McpGrants.use((grants) => grants.setAskFirst(serverId, name, enabled))

export const approvalView = (id: string) => Approvals.use((approvals) => approvals.view(id))

/**
 * Where a decided call's outcome goes: the routine run waiting on it resumes with it, else it is the owner's next
 * message in the chat that held the call (`submit`).
 */
const continuation =
  <R>(
    routines: RoutineRunner,
    submit: (chat: string, text: string, operationId: string) => Effect.Effect<unknown, AppError, R>,
  ) =>
  (session: string, text: string, operationId: string) =>
    Effect.gen(function* () {
      const record = yield* RoutineRuns.useSync((store) => store.session(session))
      if (record?.state === 'running') return yield* attempt(() => routines.start(record, { text, operationId }))
      const chat = yield* Chats.useSync((chats) => chats.chatOf(session))
      if (chat === undefined) return yield* new NotFound({ what: 'chat' })
      return yield* submit(chat, text, operationId)
    })

/** The owner's decision on a held call, its outcome delivered through the Durable Object's own `submit`. */
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
    continue: continuation(input.routines, (chat, text, operationId) =>
      attempt(async () => unwrap(await input.submit(chat, text, operationId))),
    ),
  })

/** What a decision through the owner API reads: the held call and its dispatch, and the owner's message after. */
type DecisionServices =
  | AgentInput
  | Apps
  | Budget
  | Capabilities
  | Chats
  | Conversations
  | Entitlements
  | Files
  | Invocations
  | LegacyApprovals
  | Mcp
  | Personas
  | Resident
  | RoutineRuns
  | Skills

/**
 * The owner's decision on a held call, as the owner API runs it: the outcome is the owner's message, submitted in this
 * program after the same admission an owner request gets (the plan, then a renewal of resident authority). Its type is
 * written out: the owner API's handlers reach it, and their types must not depend on the agent's services.
 */
export const decideOwnerApproval = (
  id: string,
  allowed: boolean,
): Effect.Effect<ApprovalView, AppError, DecisionServices> =>
  Effect.gen(function* () {
    const input = yield* AgentInput
    const admit = Effect.andThen(
      Entitlements.use((plans) => plans.require()),
      Resident.use((resident) => resident.renew()),
    )
    return yield* decideApproval({
      id,
      allowed,
      run: input.run,
      continue: continuation(input.routines, (chat, text, operationId) =>
        Effect.andThen(
          admit,
          submitOwner({
            harness: input.harness,
            applied: input.applied,
            routines: input.routines,
            subagents: input.subagents,
            personas: input.personas,
            run: input.run,
            thread: chat,
            text,
            operationId,
            context: {},
          }),
        ),
      ),
    })
  })

/** A direct owner read, with the same exact App resource grant as the existing bridge. */
export const ownerResource = (serverId: string, uri: string, caller: 'human' | 'app') =>
  McpConnections.use((connections) => connections.readResource(serverId, uri, caller))
