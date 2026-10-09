import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { type AppError, toAppError } from './http/errors.ts'
import type { ChatDirectory } from './chats/directory.ts'
import type { ConversationRegistry } from './conversations.ts'
import type { ChatMover } from './chats/mover.ts'

/** The Agent DO's application services, provided once per object through a ManagedRuntime (agent.ts). */
export class Chats extends Context.Service<Chats, ChatDirectory>()('goblin/Chats') {}
export class Conversations extends Context.Service<Conversations, ConversationRegistry>()('goblin/Conversations') {}
/** Move to thread (ADR 0034): a chat's newest finished turn into a Thread. */
export class Moves extends Context.Service<Moves, ChatMover>()('goblin/Moves') {}
export type { AgentServices } from './layers/index.ts'

/** Wrap a plain async step so its failure lands in the typed `AppError` channel. */
export const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, AppError> =>
  Effect.tryPromise({ try: run, catch: toAppError })

export const nowSecondsEffect: Effect.Effect<number> = Effect.map(Clock.currentTimeMillis, (millis) =>
  Math.floor(millis / 1000),
)
