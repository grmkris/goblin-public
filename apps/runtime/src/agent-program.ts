import type { PiHarness } from 'agents/harness/pi'
import { MAIN_THREAD, type AppContext } from '@purrable/contracts'
import * as Effect from 'effect/Effect'
import type { AppError } from './http/errors.ts'
import { Entitlements } from './billing/gates.ts'
import {
  Conversations,
  Budget,
  Resident,
  attempt,
  attemptSync,
  nowSecondsEffect,
  requireBudget,
  requireResident,
  type AgentServices,
} from './services.ts'
import { Events } from './mcp/events.ts'
import type { RoutineRunner } from './routines/runner.ts'
import { useModel, type Applied } from './agent-model.ts'
import { authoredContent, ownerContent } from './pi/content.ts'
import type { ThreadChange } from './conversations.ts'

/** The registration gate for every owner thread request. */
export const registeredThread = (thread: string) =>
  Conversations.use((conversations) => attemptSync(() => conversations.require(thread)))

export const ownerUsage = Effect.gen(function* () {
  const budget = yield* Budget
  const now = yield* nowSecondsEffect
  return yield* attempt(() => budget.today(now))
})

export const createOwnerThread = (from?: number) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    return yield* attempt(() => (from === undefined ? conversations.create(now) : conversations.branch(from, now)))
  })

export const updateOwnerThread = (thread: string, change: ThreadChange) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    return yield* attempt(() => conversations.update(thread, change, now))
  })

export const ownerRequest = <A>(program: Effect.Effect<A, AppError, AgentServices>) =>
  Effect.gen(function* () {
    yield* Entitlements.use((plans) => plans.require())
    const resident = yield* Resident
    resident.renew(yield* nowSecondsEffect)
    return yield* program
  })

export const setResident = (enabled: boolean) =>
  Effect.gen(function* () {
    const resident = yield* Resident
    const now = yield* nowSecondsEffect
    if (enabled) resident.enable(now)
    else {
      yield* (yield* Events).disableServer()
      resident.revoke(now)
    }
    return resident.status(now)
  })

export const submitOwner = (input: {
  harness: PiHarness
  applied: Applied
  routines: RoutineRunner
  thread: string
  text: string
  operationId: string
  appContext: readonly AppContext[]
}) =>
  Effect.gen(function* () {
    yield* requireBudget
    const session = yield* Conversations.use((conversations) => attemptSync(() => conversations.require(input.thread)))
    if (yield* attempt(() => input.routines.answer(session, input.operationId, input.text)))
      return { session, operationId: input.operationId, accepted: true }
    yield* useModel(input.harness, input.applied, session)
    return yield* attempt(() =>
      input.harness.submit(ownerContent(input.text, input.appContext), { session, operationId: input.operationId }),
    )
  })

export const askClient = (input: {
  harness: PiHarness
  applied: Applied
  author: string
  text: string
  operationId: string
  waitMs: number
}) =>
  Effect.gen(function* () {
    yield* requireResident
    yield* requireBudget
    yield* useModel(input.harness, input.applied, MAIN_THREAD)
    yield* attempt(() =>
      input.harness.submit(authoredContent(input.author, input.text), {
        session: MAIN_THREAD,
        operationId: input.operationId,
      }),
    )
    const result = yield* attempt(() =>
      input.harness
        .wait(input.operationId, { session: MAIN_THREAD, signal: AbortSignal.timeout(input.waitMs) })
        .catch(() => undefined),
    )
    if (result === undefined) return { status: 'running' as const, operationId: input.operationId }
    return result.status === 'done'
      ? { status: 'done' as const, operationId: input.operationId, text: result.text ?? '' }
      : { status: 'unanswered' as const, operationId: input.operationId, reason: result.reason ?? 'unanswered' }
  })
