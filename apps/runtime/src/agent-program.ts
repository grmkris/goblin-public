import type { PiHarness } from 'agents/harness/pi'
import {
  type AppContext,
  type Attachment,
  type ComposerSelection,
  type ConversationView,
  type CreateConversation,
  type UpdateConversation,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { type AppError, InvalidInput } from './http/errors.ts'
import { resolveSelections, type ResolvedSelections } from './composer.ts'
import type { RunProgram } from './pi/resident-mcp.ts'
import { Entitlements } from './billing/gates.ts'
import {
  Apps,
  Chats,
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
import { BACKGROUND, conversationId } from './pi/context.ts'
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
    yield* attempt(() => conversations.stopSubagents(input.thread))
    return yield* attempt(() => input.harness.abort({ session, ...operationId }))
  })

/** An inbound request checks entitlement without renewing resident authority. */
export const clientRequest = <A>(program: Effect.Effect<A, AppError, AgentServices>) =>
  Effect.andThen(
    Entitlements.use((plans) => plans.require()),
    program,
  )

export const ownerRequest = <A>(program: Effect.Effect<A, AppError, AgentServices>) =>
  Effect.gen(function* () {
    yield* Entitlements.use((plans) => plans.require())
    const resident = yield* Resident
    resident.renew(yield* nowSecondsEffect)
    return yield* program
  })

export const ownerResidentStatus = Effect.gen(function* () {
  const resident = yield* Resident
  return resident.status(yield* nowSecondsEffect)
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

export type OwnerMessageContext = {
  readonly appContext?: readonly AppContext[]
  readonly attachments?: readonly string[]
  readonly selections?: readonly ComposerSelection[]
}

type OwnerSubmit = {
  harness: PiHarness
  applied: Applied
  routines: RoutineRunner
  subagents: SubagentKit
  thread: string
  text: string
  operationId: string
  context: OwnerMessageContext
  run: RunProgram
}

/** What the owner's open Apps shared, each with where it comes from, read from the App registry (never the browser). */
const sharedContext = (context: readonly AppContext[], conversation: string) =>
  context.length === 0
    ? Effect.succeed<readonly SharedContext[]>([])
    : Apps.use((apps) =>
        attemptSync(() =>
          context.map(({ app, text }): SharedContext => ({ origin: apps.originOf(app, conversation), text })),
        ),
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
  session: string,
  extra: {
    readonly attachments: readonly Attachment[]
    readonly shared: readonly SharedContext[]
    readonly selections: ResolvedSelections
  },
) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const now = yield* nowSecondsEffect
    yield* attempt(() => conversations.update(view.id, { keepOpen: true }, now))
    const busy = yield* attempt(() => input.harness.session(session).busy())
    const pi = yield* attempt(() => input.harness.pi())
    const send = {
      subagent: session,
      spawner: conversations.spawnerSession(view.id),
      title: view.title ?? 'subagent',
      content: ownerContent(input.text, extra.shared, extra.attachments, extra.selections),
      text: input.text,
      operationId: input.operationId,
      busy,
    }
    const accepted = yield* attempt(() => input.subagents.ownerSend(pi, send))
    return { session, operationId: input.operationId, accepted }
  })

export const submitOwner = (input: OwnerSubmit) =>
  Effect.gen(function* () {
    const { appContext = [], attachments: paths = [], selections: picks = [] } = input.context
    yield* requireBudget
    const conversations = yield* Conversations
    const session = yield* attemptSync(() => conversations.requireOpen(input.thread))
    if (input.text.trim() === '' && !picks.some((selection) => selection.kind === 'skill'))
      return yield* new InvalidInput({ reason: 'empty_message' })
    const attachments = yield* attachedFiles(paths)
    const shared = yield* sharedContext(appContext, input.thread)
    const selections = yield* resolveSelections(session, picks, input.run)
    const view = yield* attempt(() => conversations.view(input.thread))
    const chats = yield* Chats
    const now = yield* nowSecondsEffect
    const content = ownerContent(input.text, shared, attachments, selections)
    return yield* attempt(() =>
      chats.withChat(input.thread, async () => {
        conversations.requireOpen(input.thread)
        const admitted = chats.admit(input.thread, input.operationId, now)
        if (await input.routines.answer(admitted.session, input.operationId, input.text))
          return { session: admitted.session, operationId: input.operationId, accepted: true }
        await input.run(useModel(input.harness, input.applied, admitted.session))
        if (view?.kind === 'subagent' && view.parent !== undefined)
          return input.run(sendToSubagent(input, view, admitted.session, { attachments, shared, selections }))
        return input.harness.submit(content, { session: admitted.session, operationId: input.operationId })
      }),
    )
  })

export const askClient = (
  input: {
    harness: PiHarness
    applied: Applied
    author: string
    text: string
    operationId: string
    waitMs: number
  },
  run: RunProgram,
) =>
  Effect.gen(function* () {
    yield* requireResident
    yield* requireBudget
    const chats = yield* Chats
    const now = yield* nowSecondsEffect
    const session = yield* attempt(() =>
      chats.withChat(chats.primary(), async () => {
        const admitted = chats.admit(chats.primary(), input.operationId, now)
        await run(useModel(input.harness, input.applied, admitted.session))
        await input.harness.submit(authoredContent(input.author, input.text), {
          session: admitted.session,
          operationId: input.operationId,
        })
        return chats.operation(chats.primary(), input.operationId) ?? admitted.session
      }),
    )
    const result = yield* attempt(() =>
      input.harness
        .wait(input.operationId, { session, signal: AbortSignal.timeout(input.waitMs) })
        .catch(() => undefined),
    )
    if (result === undefined) return { status: 'running' as const, operationId: input.operationId }
    return result.status === 'done'
      ? { status: 'done' as const, operationId: input.operationId, text: result.text ?? '' }
      : { status: 'unanswered' as const, operationId: input.operationId, reason: result.reason ?? 'unanswered' }
  })

export const recentOwnerMessages = (harness: PiHarness, limit: number) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    return yield* attempt(async () => {
      const main = await (await harness.pi()).conversation(conversationId(chats.session(chats.primary())), BACKGROUND)
      return main === undefined ? [] : recentMessages(main, limit)
    })
  })
