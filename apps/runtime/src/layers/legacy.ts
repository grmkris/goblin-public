import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { ProfilesInstance } from '../capabilities/profiles.ts'
import { ChatDirectory } from '../chats/directory.ts'
import { ChatMover } from '../chats/mover.ts'
import { nowSeconds } from '../clock.ts'
import { ConversationRegistry } from '../conversations.ts'
import { MemoriesInstance } from '../memory/memory.ts'
import { CheapModels } from '../memory/model.ts'
import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import { TranscriptsInstance } from '../retrieval/index.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { Chats, Conversations, Moves } from '../services.ts'

// What is left of the legacy start: lane C's three steps (the chat directory, the conversation registry and the
// mover), in their places of the start's order (layers/index.ts), until lane C's layer makes them.

/** 4. The chat directory: every chat id and its current Pi session. */
export const ChatsStep: Layer.Layer<Chats, never, Db> = Layer.effect(
  Chats,
  Db.useSync((db) => new ChatDirectory(db)),
)

/** 10. The conversation registry (main is registered here, once). */
export const ConversationsStep: Layer.Layer<
  Conversations,
  never,
  AgentInput | Db | Chats | MemoriesInstance | ProfilesInstance | CheapModels
> = Layer.effect(
  Conversations,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const cheap = yield* CheapModels
    const kit = {
      thread: input.thread,
      recall: input.memory.recall,
      memories: yield* MemoriesInstance,
      namer: cheap('naming'),
      capabilities: yield* ProfilesInstance,
      chats: yield* Chats,
    }
    return new ConversationRegistry(yield* Db, input.harness, kit, nowSeconds())
  }),
)

/**
 * 14. Move to thread. A move a restart interrupted finishes once the services are up again (ADR 0034); it never holds
 * up the start, so its reconcile runs on while the steps after this one are built.
 */
export const MovesStep: Layer.Layer<
  Moves,
  never,
  AgentInput | Db | Chats | Conversations | ProfilesInstance | MemoriesInstance | TranscriptsInstance
> = Layer.effect(
  Moves,
  Effect.gen(function* () {
    const input = yield* AgentInput
    const transcripts = yield* TranscriptsInstance
    const moves = new ChatMover({
      db: yield* Db,
      harness: input.harness,
      chats: yield* Chats,
      conversations: yield* Conversations,
      capabilities: yield* ProfilesInstance,
      memories: yield* MemoriesInstance,
      thread: input.thread,
      recall: input.memory.recall,
      reassign: (session, from, chat) => transcripts.reassign(session, from, chat),
      ...input.moves,
    })
    moves.reconcile().catch((error: unknown) => {
      writeLine('error', { event: 'failure', where: 'moves.reconcile', 'error.type': safeErrorType(error) })
    })
    return moves
  }),
)

/** What the legacy steps provide: the services.ts tags and the start's own, until each lane's layer replaces one. */
export type LegacyServices =
  | Layer.Success<typeof ChatsStep>
  | Layer.Success<typeof ConversationsStep>
  | Layer.Success<typeof MovesStep>
