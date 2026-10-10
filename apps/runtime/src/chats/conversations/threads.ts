import type { Conversation, EntryId } from '@earendil-works/pi-durable'
import { type CreateConversation, type HelperExclusion, PERSONAL_TOPIC } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { writeHelperExclusions } from '../../capabilities/profiles.ts'
import { epochSeconds } from '../../clock.ts'
import { Conflict, InvalidInput, NotFound, attempt, attemptSync } from '../../http/errors.ts'
import { FlowEvents, withFlow } from '../../observability/flows.ts'
import type { KeyedLock } from '../../observability/lock.ts'
import { BACKGROUND, entryId } from '../../pi/context.ts'
import { settledEnd } from '../../pi/turns.ts'
import { appPersonaForks } from '../../storage/personas.ts'
import { appConversations } from '../../storage/schema.ts'
import { appTopics } from '../../storage/topics.ts'
import {
  type ChatDb,
  type StoredChat,
  chatOfSession,
  chatRow,
  chatSession,
  conversationAbove,
  conversationOfTopic,
  openChatSession,
  primaryChat,
  registerChat,
  topicOfChat,
} from '../directory.ts'
import { fromPi } from '../../pi/sessions.ts'
import type { ChatOperations, PersonaFork, ThreadAnchor } from '../service.ts'
import {
  type RegistryCore,
  changed,
  describe,
  insertThread,
  newSession,
  piConversation,
  piTools,
  registered,
} from './core.ts'
import { recallFrom } from './reads.ts'

// The registry's new chats (ADRs 0030, 0032, 0034): Threads (branched, empty, or started from a chat's newest settled
// entry, once per operation), a Topic's Conversation, and the subagents, Persona forks and routine chats it registers.

/** The operation that made a thread, when one did: a repeat of it finds the same thread. */
type Origin = { readonly originOp?: string }

/** Entries a thread may branch from: something the owner or the agent said, never a tool or system record. */
const BRANCHABLE = new Set(['pi.user', 'pi.assistant'])

/** The flow, and the receipt's kind, of a thread operation by where it starts its Thread. */
const threadFlow = (anchor: ThreadAnchor) => (anchor === 'latest' ? 'start' : anchor === 'empty' ? 'empty' : 'reply')

/** What the registry's new chats work with besides its core: receipts, flows and the per-key lock. */
type ThreadPorts = {
  readonly operations: ChatOperations['Service']
  readonly flows: FlowEvents['Service']
  readonly locks: KeyedLock['Service']
}

/**
 * A thread forked from `from` at `at`, in its Topic. The fork starts from the parent's agent as it was at that entry,
 * made a thread: the host's extensions and the thread's (a subagent's own selection and instructions go), its tool
 * filter set to the parent's switches now. A thread from a subagent is the owner engaging with it, so that subagent
 * stays open after it reports.
 */
const forkThread = Effect.fn('Conversations.forkThread')(function* (
  core: RegistryCore,
  from: StoredChat,
  fork: { readonly source: Conversation; readonly at: EntryId; readonly now: number; readonly origin: Origin },
) {
  const { db } = core
  const { source, at, now, origin } = fork
  const recallThrough = yield* attemptSync(() => recallFrom(db, from, at))
  const extensions = { add: recallThrough === null ? [core.thread] : [core.thread, core.recall] }
  const agent = { extensions, instructions: null, tools: yield* piTools(core, from.chatId) }
  const made = yield* attempt(() => source.fork(at, { ownership: { kind: 'ownerless' }, agent }, BACKGROUND))
  if (from.kind === 'subagent') {
    yield* attemptSync(() =>
      db.update(appConversations).set({ keepOpenAt: now }).where(eq(appConversations.chatId, from.chatId)).run(),
    )
    yield* changed(core, [from.chatId])
  }
  const row = { chatId: String(made.id), kind: 'thread', parentSession: from.chatId, forkEntry: at } as const
  return yield* insertThread(core, { ...row, recallThrough, topicId: from.topicId, ...origin }, now)
})

/**
 * A thread that sees `parent` as it was at `entry` (a message in it) and continues on its own; the parent never sees
 * it. Any open conversation branches: main, a thread or a subagent. Pi forks by reference, so nothing is copied.
 */
const branch = Effect.fn('Conversations.branch')(function* (
  core: RegistryCore,
  parent: string,
  at: { readonly entry: number; readonly now: number; readonly origin: Origin },
) {
  yield* attemptSync(() => openChatSession(core.db, parent))
  const from = yield* registered(core, parent)
  const source = yield* piConversation(core, parent)
  const id = entryId(at.entry)
  const [entry] = (yield* attempt(() => source.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, BACKGROUND)))
    .items
  if (entry === undefined || !BRANCHABLE.has(entry.kind)) return yield* new InvalidInput({ reason: 'branch_entry' })
  return yield* forkThread(core, from, { source, at: entry.id, now: at.now, origin: at.origin })
})

/**
 * An empty thread the owner started under the Topic Conversation `channel`, which learns its name once it has one
 * (`announce`).
 */
const createIn = Effect.fn('Conversations.createIn')(function* (
  core: RegistryCore,
  channel: string,
  now: number,
  origin: Origin = {},
) {
  yield* attemptSync(() => openChatSession(core.db, channel))
  const { topicId } = yield* registered(core, channel)
  const session = yield* newSession(core, [core.thread], channel)
  const row = { chatId: session, kind: 'thread', parentSession: channel, mainNote: 'owed', topicId } as const
  return yield* insertThread(core, { ...row, ...origin }, now)
})

/**
 * From `parent`'s composer (Start thread): forked at its newest entry outside a running turn, or empty when there is
 * none. A subagent's composer starts none (it writes to the subagent).
 */
const startLatest = Effect.fn('Conversations.startLatest')(function* (
  core: RegistryCore,
  parent: string,
  op: string,
  now: number,
) {
  yield* attemptSync(() => openChatSession(core.db, parent))
  const from = yield* registered(core, parent)
  if (from.kind === 'subagent') return yield* new InvalidInput({ reason: 'start_thread' })
  const source = yield* piConversation(core, parent)
  const harness = yield* fromPi(core.pi.pi)
  const session = yield* attemptSync(() => chatSession(core.db, parent))
  const at = yield* attempt(() => settledEnd(harness, session, source))
  const origin = { originOp: op }
  if (at !== undefined) return yield* forkThread(core, from, { source, at, now, origin })
  const started = yield* newSession(core, [core.thread], parent)
  const row = { chatId: started, kind: 'thread', parentSession: parent, topicId: from.topicId, originOp: op } as const
  return yield* insertThread(core, row, now)
})

/**
 * The Thread `op` makes from `parent`, once, under the operation's turn of the lock (`thread-op:<op>`): a repeat
 * waits for the first and finds its Thread by `origin_op` (`existing`), and the same operation from another chat is a
 * `Conflict`. Forked at `anchor.entry` (Reply), empty under the Conversation `parent` sits under ("+"), or from the
 * composer (`latest`). The lock covers Pi's fork, never a model call.
 */
const startOnce = (core: RegistryCore, locks: KeyedLock['Service'], parent: string, op: string, anchor: ThreadAnchor) =>
  locks.withLock(`thread-op:${op}`)(
    Effect.gen(function* () {
      const now = yield* epochSeconds
      const home = anchor === 'empty' ? yield* attemptSync(() => conversationAbove(core.db, parent)) : parent
      const existing = core.db.select().from(appConversations).where(eq(appConversations.originOp, op)).get()
      if (existing !== undefined) {
        if (existing.parentSession !== home) return yield* new Conflict({ reason: 'operation_used' })
        return { view: yield* describe(core, existing), existing: true }
      }
      const origin = { originOp: op }
      const view =
        anchor === 'empty'
          ? yield* createIn(core, home, now, origin)
          : anchor === 'latest'
            ? yield* startLatest(core, parent, op, now)
            : yield* branch(core, parent, { entry: anchor.entry, now, origin })
      return { view, existing: false }
    }),
  )

/**
 * The Thread operation `operationId` starts from `parent` at `anchor` (ADR 0034): the Thread made once per operation,
 * its receipt in the chat it came from (moved on to `settled` with the Thread it made), and its `start`, `reply` or
 * `empty` flow.
 */
const startThread = Effect.fn('Conversations.startThread')(function* (
  core: RegistryCore,
  ports: ThreadPorts,
  thread: { readonly parent: string; readonly operationId: string; readonly anchor: ThreadAnchor },
) {
  const { parent, operationId, anchor } = thread
  const kind = threadFlow(anchor)
  const flow = { flow: kind, via: 'app', actor: 'owner', parentChat: parent, operationId } as const
  const started = ports.operations.tracked(
    parent,
    operationId,
    { kind, origin: 'owner' },
    () => startOnce(core, ports.locks, parent, operationId, anchor),
    (made) => ({ state: 'settled', targetChat: made.view.id }),
  )
  const made = yield* started.pipe(
    withFlow(flow, ({ view, existing }) => ({ chat: view.id, status: existing ? 'replayed' : 'ok' })),
    Effect.provideService(FlowEvents, ports.flows),
  )
  return made.view
})

/**
 * The owner's create: a Thread branched from an entry of an open chat, or an empty one under a Topic's. A create with
 * an operation id is that chat's thread operation, so a repeat finds the same Thread; one without stays the plain
 * create.
 */
const create = Effect.fn('Conversations.create')(function* (
  core: RegistryCore,
  ports: ThreadPorts,
  input: CreateConversation,
) {
  const { from, topic, operationId } = input
  const channel = attemptSync(() => conversationOfTopic(core.db, topic ?? PERSONAL_TOPIC))
  if (operationId !== undefined) {
    if (from !== undefined)
      return yield* startThread(core, ports, {
        parent: from.conversation,
        operationId,
        anchor: { entry: from.entry },
      })
    return yield* startThread(core, ports, { parent: yield* channel, operationId, anchor: 'empty' })
  }
  const now = yield* epochSeconds
  if (from !== undefined) return yield* branch(core, from.conversation, { entry: from.entry, now, origin: {} })
  return yield* createIn(core, yield* channel, now)
})

/**
 * Where a routine of `topic` lives and reports: that Topic's Conversation, or Personal's while the Topic is archived
 * or gone, so a routine left running (archive leaves schedules alone) is never reported out of sight.
 */
export const routineHome = (db: ChatDb, topic: number): { readonly chat: string; readonly topic: number } => {
  const row = db.select().from(appTopics).where(eq(appTopics.id, topic)).get()
  return row === undefined || row.archivedAt !== null
    ? { chat: primaryChat, topic: PERSONAL_TOPIC }
    : { chat: row.chatId, topic }
}

/** Registers a subagent's chat under the one that started it; a relay repeats it, so it is idempotent. */
const registerSubagent = Effect.fn('Conversations.registerSubagent')(function* (
  core: RegistryCore,
  subagent: { readonly session: string; readonly parent: string; readonly name: string },
  exclusions: readonly HelperExclusion[],
) {
  const { db } = core
  const { session, parent, name } = subagent
  if (chatRow(db, session) !== undefined) return
  const parentChat = chatOfSession(db, parent)
  if (parentChat === undefined) return yield* new NotFound({ what: 'spawner chat' })
  const now = yield* epochSeconds
  yield* attemptSync(() => {
    const row = { chatId: session, spawnerSession: parent, kind: 'subagent', title: name, parentSession: parentChat }
    const topicId = topicOfChat(db, parentChat)
    db.transaction(() => {
      registerChat(db, { ...row, kind: 'subagent', topicId, createdAt: now })
      writeHelperExclusions(db, session, exclusions, now)
    })
  })
  yield* changed(core, [session])
})

/**
 * Lists the fork a Persona answers in (ADR 0033): a hidden thread of its parent's Topic, never listed and never open
 * to the owner. Its switches are the parent's now. The setup the ask froze is kept for it first (ADR 0040), so a fork
 * that is listed always has it; the scope joins it with its Topic's setup.
 */
const registerPersona = Effect.fn('Conversations.registerPersona')(function* (
  core: RegistryCore,
  session: string,
  parentChat: string,
  persona: PersonaFork,
) {
  if (chatRow(core.db, session) !== undefined) return
  const now = yield* epochSeconds
  const topicId = yield* attemptSync(() => {
    core.db
      .insert(appPersonaForks)
      .values({
        chatId: session,
        personaId: persona.id,
        revision: persona.revision,
        setup: JSON.stringify(persona.setup),
        createdAt: now,
      })
      .onConflictDoNothing()
      .run()
    return topicOfChat(core.db, parentChat)
  })
  const row = {
    chatId: session,
    role: 'persona',
    kind: 'thread',
    title: persona.name,
    parentSession: parentChat,
  } as const
  yield* insertThread(core, { ...row, topicId }, now)
})

/**
 * A task-created routine conversation starts empty and copies no exclusions or announcement; it sits under its
 * routine's Topic's Conversation.
 */
const registerRoutine = Effect.fn('Conversations.registerRoutine')(function* (
  core: RegistryCore,
  routine: { readonly session: string; readonly runId: string; readonly title: string },
  topic: number,
) {
  const { db } = core
  const now = yield* epochSeconds
  yield* attemptSync(() => {
    const home = routineHome(db, topic)
    const row = { chatId: routine.session, kind: 'thread', title: routine.title, parentSession: home.chat } as const
    registerChat(
      db,
      { ...row, topicId: home.topic, routineRunId: routine.runId, createdAt: now, mainNote: null },
      'keep',
    )
  })
  yield* changed(core, [routine.session])
})

/** The registry's new chats over its core and ports. */
export const registryThreads = (core: RegistryCore, ports: ThreadPorts) => ({
  create: (input: CreateConversation) => create(core, ports, input),
  startThread: (parent: string, operationId: string, anchor: ThreadAnchor) =>
    startThread(core, ports, { parent, operationId, anchor }),
  openConversation: (subagents: boolean) =>
    newSession(core, [], { tools: subagents ? null : { remove: core.subagentTools } }).pipe(
      Effect.withSpan('Conversations.openConversation'),
    ),
  registerSubagent: (session: string, parent: string, name: string, exclusions: readonly HelperExclusion[] = []) =>
    registerSubagent(core, { session, parent, name }, exclusions),
  registerPersona: (session: string, parentChat: string, persona: PersonaFork) =>
    registerPersona(core, session, parentChat, persona),
  registerRoutine: (session: string, runId: string, title: string, topic: number = PERSONAL_TOPIC) =>
    registerRoutine(core, { session, runId, title }, topic),
})
