import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { requirePlan } from '../billing/gates.ts'
import { sendOutcome } from '../agent-program.ts'
import { Chats } from '../chats/service.ts'
import { type AppError, NotFound } from '../http/errors.ts'
import { resumePersona } from '../personas/ask.ts'
import { RoutineControl, RoutineRuns } from '../routines/service.ts'
import { decideApproval } from './approval-decision.ts'
import { answerUrlRequest } from './url-request.ts'
import { Approvals, McpConnections, McpGrants, Resident } from './service.ts'
import type { HeldCallOutcome } from './types.ts'

export const setAskFirst = (connectionId: string, name: string, enabled: boolean) =>
  McpGrants.use((grants) => grants.setAskFirst(connectionId, name, enabled))

export const approvalView = (id: string) => Approvals.use((approvals) => approvals.view(id))

/** An outcome as plain text, for the inputs that take only text: a routine run's, a Persona fork's. */
const plainOutcome = ({ text, outcome }: HeldCallOutcome): string => `${text}\n${JSON.stringify(outcome)}`

/**
 * Where a decided call's outcome goes: the routine run waiting on it resumes with it, a Persona's fork goes on from it
 * and answers again in its chat (ADR 0041), else it goes into the chat that held the call (`submit`).
 */
const continuation =
  <A, R>(
    admit: Effect.Effect<unknown, AppError, A>,
    submit: (chat: string, outcome: HeldCallOutcome, operationId: string) => Effect.Effect<unknown, AppError, R>,
  ) =>
  (session: string, outcome: HeldCallOutcome, operationId: string) =>
    Effect.gen(function* () {
      const record = yield* (yield* RoutineRuns).session(session)
      if (record?.state === 'running')
        return yield* RoutineControl.use((control) =>
          control.start(record, { text: plainOutcome(outcome), operationId }),
        )
      const chats = yield* Chats
      const chat = yield* chats.chatOf(session)
      if (Option.isNone(chat)) return yield* new NotFound({ what: 'chat' })
      yield* admit
      if (yield* chats.isHidden(chat.value)) return yield* resumePersona(chat.value, operationId, plainOutcome(outcome))
      return yield* submit(chat.value, outcome, operationId)
    })

/**
 * Where an owner's decision goes, as the owner API runs it: the outcome goes into the chat (`sendOutcome`, not as the
 * owner's message), after the same admission an owner request gets (the plan, then a renewal of resident authority).
 */
export const ownerContinuation = continuation(
  Effect.andThen(
    requirePlan(),
    Resident.use((resident) => resident.renew()),
  ),
  sendOutcome,
)

/** The owner's decision on a held call, as the owner API runs it. */
export const decideOwnerApproval = (id: string, allowed: boolean) =>
  decideApproval({ id, allowed, continue: ownerContinuation })

/** The owner's answer to a URL request (ADR 0042), as the owner API runs it. */
export const answerOwnerUrlRequest = (id: string, action: 'accept' | 'decline') =>
  answerUrlRequest({ id, action, continue: ownerContinuation })

/** A direct owner read, with the same exact App resource grant as the existing bridge. */
export const ownerResource = (connectionId: string, uri: string, caller: 'human' | 'app') =>
  McpConnections.use((connections) => connections.readResource(connectionId, uri, caller))
