import type { PiHarness } from 'agents/harness/pi'
import {
  MAIN_THREAD,
  type AppContext,
  type Attachment,
  type ConversationView,
  type CreateConversation,
  type UpdateConversation,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import type { AppError } from './http/errors.ts'
import { Entitlements } from './billing/gates.ts'
import {
  Apps,
  Conversations,
  Files,
  RoutineRuns,
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
import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import { BACKGROUND } from './pi/context.ts'
import { recentMessages } from './pi/transcript.ts'
import { type SharedContext, authoredContent, ownerContent } from './pi/content.ts'
import type { SubagentKit } from './pi/subagents.ts'

/** The registration gate for every owner conversation request. */
export const registeredConversation = (id: string) =>
  Conversations.use((conversations) => attemptSync(() => conversations.require(id)))

export const ownerUsage = Effect.gen(function* () {
  const budget = yield* Budget
  const now = yield* nowSecondsEffect
  return yield* attempt(() => budget.today(now))
})

/** A thread from a message of an open conversation, or an empty one under main. */
export const createOwnerConversation = ({ from }: CreateConversation) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    return yield* attempt(() =>
      from === undefined ? conversations.create(now) : conversations.branch(from.conversation, from.entry, now),
    )
  })

/**
 * Rename, close or reopen, or pin a subagent open. A Close settles the live routine runs among what it closes first, so
 * a routine stopped this way reads as stopped by the owner, never as failed.
 */
export const updateOwnerConversation = (routines: RoutineRunner, id: string, change: UpdateConversation) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const runs = yield* RoutineRuns
    const now = yield* nowSecondsEffect
    if (change.closed === true) {
      const closing = new Set(yield* attemptSync(() => conversations.subtree(id)))
      const live = runs.live().filter((run) => run.sessionId !== null && closing.has(run.sessionId))
      for (const run of live) yield* attempt(() => routines.stop(run.id, 'Closed by owner'))
    }
    return (yield* attempt(() => conversations.update(id, change, now))).view
  })

/** The owner has seen a conversation's newest reply. */
export const markOwnerRead = (id: string) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    yield* attemptSync(() => conversations.markRead(id, now))
    return true
  })

/** Stop in a conversation: its current work, a routine's run when it is one, and the subagents it started. */
export const stopOwner = (input: {
  harness: PiHarness
  routines: RoutineRunner
  thread: string
  operationId: string | undefined
}) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const session = yield* attemptSync(() => conversations.require(input.thread))
    const run = (yield* RoutineRuns).session(session)
    if (run !== undefined) {
      yield* attempt(() => input.routines.stop(run.id))
      return true
    }
    const operationId = input.operationId === undefined ? {} : { operationId: input.operationId }
    yield* attempt(() => conversations.stopSubagents(session))
    return yield* attempt(() => input.harness.abort({ session, ...operationId }))
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

type OwnerSubmit = {
  harness: PiHarness
  applied: Applied
  routines: RoutineRunner
  subagents: SubagentKit
  thread: string
  text: string
  operationId: string
  appContext: readonly AppContext[]
  /** Paths of the owner's files attached to the message. */
  attachments: readonly string[]
}

/** What the owner's open Apps shared, each with where it comes from, read from the App registry (never the browser). */
const sharedContext = (context: readonly AppContext[]) =>
  context.length === 0
    ? Effect.succeed<readonly SharedContext[]>([])
    : Apps.use((apps) =>
        attemptSync(() => context.map(({ app, text }): SharedContext => ({ origin: apps.originOf(app), text }))),
      )

/** The owner's attached files as they are now: each must exist, or the message is refused. */
const attachedFiles = (paths: readonly string[]) =>
  paths.length === 0
    ? Effect.succeed<readonly Attachment[]>([])
    : Files.use((files) =>
        attempt(() =>
          Promise.all(
            paths.map(async (path): Promise<Attachment> => {
              const { name, size, mimeType } = await files.stat(path)
              return { path, name, size, mimeType }
            }),
          ),
        ),
      )

/**
 * The owner's message to a subagent: the subagent stays open after its job (the owner engaged with it), and the
 * message goes through a relay in its spawner, so the answer reports up with the owner's words quoted. While the
 * subagent works, the message steers it.
 */
const sendToSubagent = (
  input: OwnerSubmit,
  view: ConversationView,
  spawner: string,
  extra: { readonly attachments: readonly Attachment[]; readonly shared: readonly SharedContext[] },
) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    yield* attempt(() => conversations.update(view.id, { keepOpen: true }, now))
    const busy = yield* attempt(() => input.harness.session(view.id).busy())
    const pi = yield* attempt(() => input.harness.pi())
    const send = {
      subagent: view.id,
      spawner,
      title: view.title ?? 'subagent',
      content: ownerContent(input.text, extra.shared, extra.attachments),
      text: input.text,
      operationId: input.operationId,
      busy,
    }
    const accepted = yield* attempt(() => input.subagents.ownerSend(pi, send))
    return { session: view.id, operationId: input.operationId, accepted }
  })

export const submitOwner = (input: OwnerSubmit) =>
  Effect.gen(function* () {
    yield* requireBudget
    const conversations = yield* Conversations
    const session = yield* attemptSync(() => conversations.requireOpen(input.thread))
    if (yield* attempt(() => input.routines.answer(session, input.operationId, input.text)))
      return { session, operationId: input.operationId, accepted: true }
    const attachments = yield* attachedFiles(input.attachments)
    const shared = yield* sharedContext(input.appContext)
    yield* useModel(input.harness, input.applied, session)
    const view = yield* attempt(() => conversations.view(session))
    if (view?.kind === 'subagent' && view.parent !== undefined)
      return yield* sendToSubagent(input, view, view.parent, { attachments, shared })
    const content = ownerContent(input.text, shared, attachments)
    return yield* attempt(() => input.harness.submit(content, { session, operationId: input.operationId }))
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

export const recentOwnerMessages = (harness: PiHarness, limit: number) =>
  attempt(async () => {
    const main = await (await harness.pi()).conversation(ROOT_CONVERSATION_ID, BACKGROUND)
    return main === undefined ? [] : recentMessages(main, limit)
  })
