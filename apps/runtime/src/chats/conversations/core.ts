import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import type { ConversationView } from '@goblin/contracts'
import type { PiHarness } from 'agents/harness/pi'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { storedAsks } from '../../attention.ts'
import { type PiTools, piToolsFor } from '../../capabilities/profiles.ts'
import { type AppError, InvalidInput, NotFound, attempt, attemptSync } from '../../http/errors.ts'
import { BACKGROUND } from '../../pi/context.ts'
import { PiSessions, fromPi } from '../../pi/sessions.ts'
import { type ChatActivity, ReplyLedger } from '../../replies.ts'
import { Changes } from '../../runtime/changes.ts'
import { Db } from '../../runtime/db.ts'
import { AgentInput } from '../../runtime/input.ts'
import { type ChatRow, type StoredChat, chatRow, chatSession, isChannel, registerChat } from '../directory.ts'
import { movedFrom } from '../moves.ts'

/** Why a Topic's Conversation refuses a rename or Close: Personal's is Main; another's follows its Topic. */
export const channelRefusal = (row: StoredChat) =>
  new InvalidInput({ reason: row.role === 'primary' ? 'main_thread' : 'topic_conversation' })

/** How a conversation is named in a note it leaves elsewhere: an untitled one says so, never a made-up name. */
export const labelOf = (row: StoredChat): string =>
  row.title === null ? `${row.kind} (untitled)` : `${row.kind} "${row.title}"`

/**
 * What every part of the registry works with, made once by its layer: the agent's database and Pi, the change bus,
 * the thread extensions and subagent tools a new thread is configured with, and each chat's reply tally, which the
 * registry keeps for as long as the agent is awake.
 */
export type RegistryCore = {
  readonly db: Db['Service']
  readonly pi: PiSessions['Service']
  /** Pi's harness, for what `PiSessions` does not cover: a new session. */
  readonly harness: PiHarness
  readonly changes: Changes['Service']
  readonly thread: Extension
  readonly recall: Extension
  readonly subagentTools: readonly ToolRegistration[]
  readonly replies: ReplyLedger
}

/** The registry's core over the agent's services and instance input. */
export const makeRegistryCore: Effect.Effect<RegistryCore, never, Db | PiSessions | Changes | AgentInput> = Effect.gen(
  function* () {
    const { harness, thread, memory, subagentTools } = yield* AgentInput
    return {
      db: yield* Db,
      pi: yield* PiSessions,
      harness,
      changes: yield* Changes,
      thread,
      recall: memory.recall,
      subagentTools,
      replies: new ReplyLedger(),
    }
  },
)

/** Tells `conversations.changed` which chats a write changed, inside the write. */
export const changed = (core: RegistryCore, ids: readonly string[]): Effect.Effect<void> =>
  ids.length === 0 ? Effect.void : core.changes.publish('conversations.changed', { ids })

/** A registered chat's row; anything else is `NotFound`. */
export const registered = (core: RegistryCore, chat: string): Effect.Effect<StoredChat, AppError> =>
  Effect.suspend(() => {
    const row = chatRow(core.db, chat)
    return row === undefined ? Effect.fail(new NotFound({ what: 'conversation' })) : Effect.succeed(row)
  })

/** The Pi conversation a registered chat is on now; `NotFound` when Pi has none. */
export const piConversation = Effect.fn('Conversations.piConversation')(function* (core: RegistryCore, chat: string) {
  const session = yield* attemptSync(() => chatSession(core.db, chat))
  const found = yield* fromPi(core.pi.conversation(session))
  if (Option.isNone(found)) return yield* new NotFound({ what: 'conversation' })
  return found.value
})

/**
 * A conversation as the owner sees it, with the messages written in it (not those it inherited). One whose Pi
 * conversation is gone still lists, with no replies, so it never takes the whole list down.
 */
export const describe = Effect.fn('Conversations.describe')(function* (core: RegistryCore, row: StoredChat) {
  const { db } = core
  const session = yield* attemptSync(() => chatSession(db, row.chatId))
  const found = yield* fromPi(core.pi.conversation(session))
  const activity: ChatActivity = Option.isNone(found)
    ? { replies: 0, asks: [] }
    : yield* attempt(() => core.replies.stats(session, found.value, row.forkEntry ?? 0))
  const attention = [...activity.asks, ...storedAsks(db, { id: row.chatId, session }, yield* Clock.currentTimeMillis)]
  return {
    id: row.chatId,
    ...(row.role === 'primary' ? { primary: true } : {}),
    topic: row.topicId,
    ...(isChannel(row) ? { conversation: true } : {}),
    kind: row.kind,
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.parentSession === null ? {} : { parent: row.parentSession }),
    ...(row.forkEntry === null ? {} : { forkEntry: row.forkEntry }),
    createdAt: row.createdAt,
    ...(row.closedAt === null ? {} : { closedAt: row.closedAt }),
    ...(row.closedBy === null ? {} : { closedBy: row.closedBy }),
    keepOpen: row.keepOpenAt !== null,
    replies: activity.replies,
    ...(activity.lastReplyAt === undefined ? {} : { lastReplyAt: activity.lastReplyAt }),
    ...(row.readAt === null ? {} : { readAt: row.readAt }),
    ...(attention.length === 0 ? {} : { attention }),
    ...movedFrom(db, row.originOp),
  } satisfies ConversationView
})

/** Pi's tool filter for a new conversation that works like `chat` (its subagent switch). */
export const piTools = (core: RegistryCore, chat: string) =>
  attemptSync(() => piToolsFor(core.db, core.subagentTools, chat))

/** A new top-level Pi session (not a fork) with `extensions` added and `like`'s tool filter, or `tools` given. */
export const newSession = Effect.fn('Conversations.newSession')(function* (
  core: RegistryCore,
  extensions: readonly Extension[],
  like: string | { readonly tools: PiTools },
) {
  const session = yield* attempt(() => core.harness.sessions.create())
  const tools = typeof like === 'string' ? yield* piTools(core, like) : like.tools
  const created = yield* fromPi(core.pi.conversation(session.id))
  if (Option.isNone(created)) return yield* new NotFound({ what: 'conversation' })
  yield* attempt(() => created.value.configure({ extensions: { add: [...extensions] }, tools }, BACKGROUND))
  return session.id
})

/** Registers a new thread; it works with its Topic's setup (ADR 0040), so nothing is copied from its parent. */
export const insertThread = Effect.fn('Conversations.insertThread')(function* (
  core: RegistryCore,
  values: Omit<ChatRow, 'createdAt'> & { readonly parentSession: string },
  now: number,
) {
  yield* attemptSync(() => {
    registerChat(core.db, { ...values, createdAt: now })
  })
  yield* changed(core, [values.chatId])
  return yield* describe(core, yield* registered(core, values.chatId))
})
