import type { ConversationId, Tx } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ChatOperations } from '../chats/service.ts'
import { Memories, type MemoryLine } from '../memory/service.ts'
import type { SkillRequestOptions } from '../mcp/types.ts'
import { KeyedLock } from '../observability/lock.ts'
import { Retrieval, retrievalOver } from '../retrieval/service.ts'
import {
  Chats,
  Learner as LegacyLearner,
  Memories as LegacyMemories,
  Retrieval as LegacyRetrieval,
  Skills as LegacySkills,
  attempt,
  attemptSync,
} from '../services.ts'
import { Learner, Skills } from '../skills/service.ts'

/**
 * Lane K's services over the legacy instances (services.ts tags), one instance each: every call is wrapped as the
 * programs wrap it today. A promise goes through `attempt` and a call that can refuse (an unknown chat or server)
 * through `attemptSync`, both into `AppError`; a plain SQLite read runs as it is.
 */
const MemoriesAdapter = Layer.effect(
  Memories,
  Effect.gen(function* () {
    const memories = yield* LegacyMemories
    const chats = yield* Chats
    const operations = yield* ChatOperations
    return Memories.of({
      status: Effect.fn('Memories.status')(function* (chat?: string) {
        const target = chat === undefined ? chats.primary() : yield* attemptSync(() => chats.conversationAbove(chat))
        const memory = memories.of(target)
        return { messages: memory.size(), summarized: memory.viewThrough() }
      }),
      size: Effect.fn('Memories.size')(function* (chat: string) {
        return yield* Effect.sync(() => memories.of(chat).size())
      }),
      sizeAt: Effect.fn('Memories.sizeAt')(function* (chat: string, entry: number) {
        return yield* Effect.sync(() => memories.of(chat).sizeAt(entry))
      }),
      activate: Effect.fn('Memories.activate')(function* (chat: string) {
        yield* attempt(() => memories.activate(chat))
      }),
      activateConversations: Effect.fn('Memories.activateConversations')(function* () {
        yield* attempt(() => memories.activateConversations())
      }),
      truncate: Effect.fn('Memories.truncate')(function* (chat: string, size: number) {
        yield* Effect.sync(() => memories.truncate(chat, size))
      }),
      // A view is placed as a passive write under the chat's admission lock, never beside a send (K1).
      step: Effect.fn('Memories.step')(function* (chat: string, signal: AbortSignal) {
        const memory = memories.of(chat)
        const next = yield* attempt(() => memory.advance(signal))
        if (next === 'more' || next === 'done') return next
        yield* operations.passiveWrite(chat, next.write)
        yield* Effect.sync(() => memory.placed(next.through))
        return 'done' as const
      }),
      startBuilder: Effect.fn('Memories.startBuilder')(function* (chat: string, start: (tx: Tx) => Promise<void>) {
        yield* attempt(() => memories.of(chat).startBuilder(start))
      }),
      zoom: Effect.fn('Memories.zoom')(function* (chat: string, line: MemoryLine, limit: number) {
        return yield* attempt(() => memories.of(chat).zoom(line.id, line.n, limit))
      }),
    })
  }),
)

/** Retrieval over the started ChatRetrieval and its index, every catch-up under the agent's KeyedLock. */
const RetrievalAdapter = Layer.effect(
  Retrieval,
  Effect.gen(function* () {
    return retrievalOver(yield* LegacyRetrieval, yield* KeyedLock)
  }),
)

const SkillsAdapter = Layer.effect(
  Skills,
  Effect.gen(function* () {
    const library = yield* LegacySkills
    return Skills.of({
      sources: Effect.fn('Skills.sources')(function* () {
        return yield* Effect.sync(() => library.sources())
      }),
      enabled: Effect.fn('Skills.enabled')(function* (serverId: string) {
        return yield* Effect.sync(() => library.enabled(serverId))
      }),
      setEnabled: Effect.fn('Skills.setEnabled')(function* (serverId: string, enabled: boolean) {
        yield* attemptSync(() => library.setEnabled(serverId, enabled))
      }),
      invalidate: Effect.fn('Skills.invalidate')(function* (serverId: string, unavailable?: boolean) {
        yield* Effect.sync(() => library.invalidate(serverId, unavailable))
      }),
      catalog: Effect.fn('Skills.catalog')(function* (
        options?: SkillRequestOptions,
        include?: (serverId: string) => boolean,
      ) {
        return yield* attempt(() => library.catalog(options, include))
      }),
      activate: Effect.fn('Skills.activate')(function* (
        session: string,
        handle: string,
        options?: SkillRequestOptions,
      ) {
        return yield* attempt(() => library.activate(session, handle, options))
      }),
      activateSelection: Effect.fn('Skills.activateSelection')(function* (
        session: string,
        serverId: string,
        uri: string,
        options: SkillRequestOptions,
      ) {
        return yield* attempt(() => library.activateSelection(session, serverId, uri, options))
      }),
      read: Effect.fn('Skills.read')(function* (
        session: string,
        handle: string,
        path: string,
        options?: SkillRequestOptions,
      ) {
        return yield* attempt(() => library.read(session, handle, path, options))
      }),
    })
  }),
)

const LearnerAdapter = Layer.effect(
  Learner,
  Effect.gen(function* () {
    const learner = yield* LegacyLearner
    return Learner.of({
      consider: Effect.fn('Learner.consider')(function* (conversation: ConversationId, signal?: AbortSignal) {
        return yield* attempt(() => learner.consider(conversation, signal))
      }),
    })
  }),
)

/** Lane K's services: memory, retrieval and skills, over the legacy instances until each gets its own layer. */
export const KnowledgeLive = Layer.mergeAll(MemoriesAdapter, RetrievalAdapter, SkillsAdapter, LearnerAdapter)
