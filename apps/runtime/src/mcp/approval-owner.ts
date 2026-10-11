import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { requirePlan } from '../billing/gates.ts'
import { sendOwnerMessage } from '../agent-program.ts'
import { Chats } from '../chats/service.ts'
import { type AppError, NotFound } from '../http/errors.ts'
import { resumePersona } from '../personas/ask.ts'
import { RoutineControl, RoutineRuns } from '../routines/service.ts'
import { decideApproval } from './approval-decision.ts'
import { Approvals, McpConnections, McpGrants, Resident } from './service.ts'

export const setAskFirst = (connectionId: string, name: string, enabled: boolean) =>
  McpGrants.use((grants) => grants.setAskFirst(connectionId, name, enabled))

export const approvalView = (id: string) => Approvals.use((approvals) => approvals.view(id))

/**
 * Where a decided call's outcome goes: the routine run waiting on it resumes with it, a Persona's fork goes on from it
 * and answers again in its chat (ADR 0041), else it is the owner's next message in the chat that held the call
 * (`submit`).
 */
const continuation =
  <A, R>(
    admit: Effect.Effect<unknown, AppError, A>,
    submit: (chat: string, text: string, operationId: string) => Effect.Effect<unknown, AppError, R>,
  ) =>
  (session: string, text: string, operationId: string) =>
    Effect.gen(function* () {
      const record = yield* (yield* RoutineRuns).session(session)
      if (record?.state === 'running')
        return yield* RoutineControl.use((control) => control.start(record, { text, operationId }))
      const chats = yield* Chats
      const chat = yield* chats.chatOf(session)
      if (Option.isNone(chat)) return yield* new NotFound({ what: 'chat' })
      yield* admit
      if (yield* chats.isHidden(chat.value)) return yield* resumePersona(chat.value, operationId, text)
      return yield* submit(chat.value, text, operationId)
    })

/**
 * The owner's decision on a held call, as the owner API runs it: the outcome is the owner's message, sent in this
 * program after the same admission an owner request gets (the plan, then a renewal of resident authority).
 */
export const decideOwnerApproval = (id: string, allowed: boolean) =>
  Effect.gen(function* () {
    const admit = Effect.andThen(
      requirePlan(),
      Resident.use((resident) => resident.renew()),
    )
    return yield* decideApproval({
      id,
      allowed,
      continue: continuation(admit, (chat, text, operationId) => sendOwnerMessage(chat, { text, operationId })),
    })
  })

/** A direct owner read, with the same exact App resource grant as the existing bridge. */
export const ownerResource = (connectionId: string, uri: string, caller: 'human' | 'app') =>
  McpConnections.use((connections) => connections.readResource(connectionId, uri, caller))
