import type { ApprovalView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Entitlements } from '../billing/gates.ts'
import { ChatOperations, Chats } from '../chats/service.ts'
import { type AppError, NotFound, toAppError } from '../http/errors.ts'
import type { RoutineRunner } from '../routines/runner.ts'
import { RoutineRuns } from '../routines/service.ts'
import { AgentInput } from '../runtime/input.ts'
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
      const record = yield* (yield* RoutineRuns).session(session)
      if (record?.state === 'running')
        return yield* Effect.tryPromise({ try: () => routines.start(record, { text, operationId }), catch: toAppError })
      const chat = yield* (yield* Chats).chatOf(session)
      if (Option.isNone(chat)) return yield* new NotFound({ what: 'chat' })
      return yield* submit(chat.value, text, operationId)
    })

/** What a decision through the owner API reads: the held call and its dispatch, and the owner's message after. */
type DecisionServices =
  | AgentInput
  | Approvals
  | ChatOperations
  | Chats
  | Entitlements
  | McpConnections
  | Resident
  | RoutineRuns

/**
 * The owner's decision on a held call, as the owner API runs it: the outcome is the owner's message, sent in this
 * program after the same admission an owner request gets (the plan, then a renewal of resident authority). Its type is
 * written out: the owner API's handlers reach it, and their types must not depend on the agent's services.
 */
export const decideOwnerApproval = (
  id: string,
  allowed: boolean,
): Effect.Effect<ApprovalView, AppError, DecisionServices> =>
  Effect.gen(function* () {
    const { run, routines } = yield* AgentInput
    const admit = Effect.andThen(
      Entitlements.use((plans) => plans.require()),
      Resident.use((resident) => resident.renew()),
    )
    return yield* decideApproval({
      id,
      allowed,
      run,
      continue: continuation(routines, (chat, text, operationId) =>
        Effect.andThen(
          admit,
          ChatOperations.use((operations) => operations.send(chat, { text, operationId })),
        ),
      ),
    })
  })

/** A direct owner read, with the same exact App resource grant as the existing bridge. */
export const ownerResource = (serverId: string, uri: string, caller: 'human' | 'app') =>
  McpConnections.use((connections) => connections.readResource(serverId, uri, caller))
