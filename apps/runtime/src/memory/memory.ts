import type { Extension } from '@earendil-works/pi-durable'
import { ChatMemory, type MemoryDeps, type MemoryOptions } from './chat-memory.ts'
import { conversationsWithoutMemory } from './store.ts'

/**
 * What every Topic Conversation's memory (ADR 0032) is made with: what one chat's memory works with, its settings, and
 * the memory extensions (the builder and `zoom`) a Conversation gets when its memory is turned on. Threads have none of
 * their own: they zoom into the Conversation above them.
 */
export type MemoryEngine = {
  readonly deps: MemoryDeps
  readonly options: MemoryOptions
  readonly extensions: readonly Extension[]
}

/** `chat`'s memory over `engine`. */
export const memoryOf = (engine: MemoryEngine, chat: string): ChatMemory =>
  new ChatMemory(chat, engine.deps, engine.options)

/** Turns on the memory of `chat`, a Topic's Conversation, once. */
export const activateMemory = async (engine: MemoryEngine, chat: string): Promise<void> => {
  await memoryOf(engine, chat).activate(engine.extensions)
}

/**
 * Turns on the memory of every Topic's Conversation that has none yet: a fresh agent's Personal, and a Topic whose
 * activation a crash cut short.
 */
export const activateConversations = async (engine: MemoryEngine): Promise<void> => {
  for (const chat of conversationsWithoutMemory(engine.deps.db)) await activateMemory(engine, chat)
}
