import type { PiHarness, PiReceipt } from 'agents/harness/pi'
import {
  type AppContext,
  type Attachment,
  type ComposerSelection,
  type ConversationView,
  type CreateConversation,
  type UpdateConversation,
} from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { Apps } from './apps/service.ts'
import { type Budget, requireBudget } from './budget.ts'
import type { Capabilities } from './capabilities/service.ts'
import type { SessionId } from './chats/directory.ts'
import { epochSeconds } from './clock.ts'
import { ChatOperations, Conversations } from './chats/service.ts'
import { resolveSelections, type ResolvedSelections } from './composer.ts'
import { Files } from './files/service.ts'
import { type FlowEvents, withFlow } from './observability/flows.ts'
import { type AppError, InvalidInput, attempt } from './http/errors.ts'
import type { McpServers, Resident } from './mcp/service.ts'
import { Invocations, type Personas } from './personas/service.ts'
import { RoutineControl, RoutineRuns } from './routines/service.ts'
import type { RunProgram } from './runtime/bridge.ts'
import { AgentInput, type AgentInputs } from './runtime/input.ts'
import type { Skills } from './skills/service.ts'
import type { Applied } from './agent-model.ts'
import { conversationId } from './pi/context.ts'
import type { PiSessions } from './pi/sessions.ts'
import { type SharedContext, ownerContent } from './pi/content.ts'
import type { SubagentKit } from './pi/subagents.ts'
import type { PersonaTurnKit } from './pi/persona-turn.ts'
import { askPersonas } from './personas/ask.ts'

/** The registration gate for every owner conversation request. */
export const registeredConversation = (id: string) => Conversations.use((conversations) => conversations.require(id))

/**
 * A thread from a message of an open conversation (in that conversation's Topic), or an empty one under a Topic's
 * Conversation: `topic`'s, else Personal's.
 */
export const createOwnerConversation = (input: CreateConversation) =>
  Conversations.use((conversations) => conversations.create(input))

/**
 * Rename, close or reopen, or pin a subagent open. A Close settles the live routine runs among what it closes first, so
 * a routine stopped this way reads as stopped by the owner, never as failed.
 */
export const updateOwnerConversation = (id: string, change: UpdateConversation) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    if (change.closed === true) {
      const closing = new Set(yield* conversations.subtree(id))
      const live = (yield* (yield* RoutineRuns).live).filter(
        (run) => run.sessionId !== null && closing.has(run.sessionId),
      )
      const control = yield* RoutineControl
      for (const run of live) yield* control.stop(run.id, 'Closed by owner')
    }
    return (yield* conversations.update(id, change)).view
  })

/** The owner has seen a conversation's newest reply. */
export const markOwnerRead = (id: string) =>
  Effect.as(
    Conversations.use((conversations) => conversations.markRead(id)),
    true,
  )

/** What the owner's Stop reaches besides the services: Pi and the Persona turns asked in the chat. */
export type StopRuntime = {
  readonly harness: PiHarness
  readonly personas: PersonaTurnKit
}

/**
 * Stop in a conversation: its current work, a routine's run when it is one, the subagents it started and the Personas
 * asked in it (their unsettled answers are dropped).
 */
export const stopOwner = (
  input: StopRuntime & {
    thread: string
    operationId: string | undefined
  },
) =>
  Effect.gen(function* () {
    const conversations = yield* Conversations
    const session = yield* conversations.require(input.thread)
    const run = yield* (yield* RoutineRuns).session(session)
    if (run !== undefined) {
      yield* RoutineControl.use((control) => control.stop(run.id))
      return true
    }
    const operationId = input.operationId === undefined ? {} : { operationId: input.operationId }
    yield* conversations.stopSubagents(input.thread)
    const invocations = yield* Invocations
    const now = yield* epochSeconds
    yield* attempt(async () => input.personas.drop(await input.harness.pi(), conversationId(session)))
    yield* invocations.stopChat(input.thread, now)
    return yield* attempt(() => input.harness.abort({ session, ...operationId }))
  })

/**
 * Stop in `chat` as the owner's Stop does, with the instance's Pi, routines and Persona turns: the one stop path, which
 * a Topic's archive takes too. Records the `stop` flow: who stopped it, and whether anything was running (`count`).
 */
export const stopChat = (
  chat: string,
  operationId?: string,
  actor: 'owner' | 'agent' = 'owner',
): Effect.Effect<
  boolean,
  AppError,
  Conversations | RoutineRuns | RoutineControl | Invocations | AgentInput | FlowEvents
> => {
  const flow = {
    flow: 'stop',
    via: actor === 'owner' ? 'app' : 'tool',
    actor,
    chat,
    ...(operationId === undefined ? {} : { operationId }),
  } as const
  return AgentInput.use((input) => stopOwner({ ...input.stopping(), thread: chat, operationId })).pipe(
    withFlow(flow, (stopped) => ({ count: stopped ? 1 : 0 })),
  )
}

export type OwnerMessageContext = {
  readonly appContext?: readonly AppContext[]
  readonly attachments?: readonly string[]
  readonly selections?: readonly ComposerSelection[]
  /** With Persona selections: answer in parallel (the default) or one after the other ("then"). */
  readonly personaOrder?: 'parallel' | 'sequence'
}

export type OwnerSubmit = {
  harness: PiHarness
  applied: Applied
  subagents: SubagentKit
  personas: PersonaTurnKit
  thread: string
  text: string
  operationId: string
  context: OwnerMessageContext
  run: RunProgram
  /** The operation this message is part of: a started thread's first message is its start's. */
  parentOp?: string
}

/** What the owner's message paths run with, from the agent's instance. */
export const ownerRuntime = ({ harness, applied, subagents, personas, run }: AgentInputs) => ({
  harness,
  applied,
  subagents,
  personas,
  run,
})

/** What the owner's open Apps shared, each with where it comes from, read from the App registry (never the browser). */
const sharedContext = (context: readonly AppContext[], conversation: string) =>
  Effect.forEach(context, ({ app, text }) =>
    Effect.map(
      Apps.use((apps) => apps.originOf(app, conversation)),
      (origin): SharedContext => ({ origin, text }),
    ),
  )

/** The owner's attached files as they are now: each must exist, or the message is refused. */
const attachedFiles = (paths: readonly string[]) =>
  Effect.forEach(
    paths,
    (path) =>
      Effect.map(
        Files.use((files) => files.stat(path)),
        ({ name, size, mimeType }): Attachment => ({ path, name, size, mimeType }),
      ),
    { concurrency: 'unbounded' },
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
    yield* conversations.update(view.id, { keepOpen: true })
    const busy = yield* attempt(() => input.harness.session(session).busy())
    const send = {
      subagent: session,
      spawner: yield* conversations.spawnerSession(view.id),
      title: view.title ?? 'subagent',
      content: ownerContent(input.text, extra.shared, extra.attachments, extra.selections),
      text: input.text,
      operationId: input.operationId,
      busy,
    }
    const accepted = yield* attempt(async () => input.subagents.ownerSend(await input.harness.pi(), send))
    return { session, operationId: input.operationId, accepted }
  })

/** What the owner's message path reads. Spelled out: `run`'s type names every agent service, the owner API's among them. */
export type OwnerSubmitServices =
  | Budget
  | Conversations
  | ChatOperations
  | Files
  | Apps
  | Capabilities
  | McpServers
  | Resident
  | Skills
  | Invocations
  | Personas
  | PiSessions
  | RoutineControl

/** The owner's words as the answer to a routine's question waiting in the session they reach, when one is. */
const routineAnswer = (operationId: string, text: string) => (admitted: SessionId) =>
  RoutineControl.use((control) => control.answer(admitted, operationId, text))

/**
 * The owner's message into a chat, or an ask of the Personas it tags. Admission (the chat open, the operation recorded,
 * a routine's waiting question answered, the session on the owner's model, Pi's submit) runs under the chat's lock.
 */
export const submitOwner = (input: OwnerSubmit): Effect.Effect<PiReceipt, AppError, OwnerSubmitServices> =>
  Effect.gen(function* () {
    const {
      appContext = [],
      attachments: paths = [],
      selections: tagged = [],
      personaOrder = 'parallel',
    } = input.context
    const personaIds = tagged.flatMap((selection) => (selection.kind === 'persona' ? [selection.personaId] : []))
    const picks = tagged.filter((selection) => selection.kind !== 'persona')
    yield* requireBudget
    const conversations = yield* Conversations
    const session = yield* conversations.requireOpen(input.thread)
    if (input.text.trim() === '' && !picks.some((selection) => selection.kind === 'skill'))
      return yield* new InvalidInput({ reason: 'empty_message' })
    const attachments = yield* attachedFiles(paths)
    const shared = yield* sharedContext(appContext, input.thread)
    const selections = yield* resolveSelections(session, picks, input.run)
    const view = Option.getOrUndefined(yield* conversations.view(input.thread))
    const content = ownerContent(input.text, shared, attachments, selections)
    if (personaIds.length > 0) {
      if (view?.kind === 'subagent') return yield* new InvalidInput({ reason: 'persona_subagent' })
      return yield* askPersonas(input, personaIds, personaOrder, content)
    }
    const relay =
      view?.kind === 'subagent' && view.parent !== undefined
        ? (admitted: SessionId) => sendToSubagent(input, view, admitted, { attachments, shared, selections })
        : undefined
    return yield* (yield* ChatOperations).send<Conversations | RoutineControl>({
      chat: input.thread,
      operationId: input.operationId,
      receipt: { kind: 'send', origin: 'owner', ...(input.parentOp === undefined ? {} : { parentOp: input.parentOp }) },
      flow: { flow: 'send', via: 'app', actor: 'owner' },
      content,
      answer: routineAnswer(input.operationId, input.text),
      ...(relay === undefined ? {} : { relay }),
    })
  })

/** The owner's message into `chat` with what came with it, as the owner API and a decided approval send it. */
export const sendOwnerMessage = (
  chat: string,
  message: { readonly text: string; readonly operationId: string; readonly context?: OwnerMessageContext },
): Effect.Effect<PiReceipt, AppError, OwnerSubmitServices | AgentInput> =>
  AgentInput.use((input) =>
    submitOwner({
      ...ownerRuntime(input),
      thread: chat,
      text: message.text,
      operationId: message.operationId,
      context: message.context ?? {},
    }),
  )
