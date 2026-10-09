import type { EntryDraft } from '@earendil-works/pi-durable'
import { and, eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { CapabilityProfiles } from '../capabilities/profiles.ts'
import { type ChatDirectory, registerChat } from '../chats/directory.ts'
import type { ConversationRegistry } from '../conversations.ts'
import type { ChatMemories } from '../memory/memory.ts'
import { appConversations } from '../storage/schema.ts'
import { topicSeedContent } from '../pi/content.ts'
import type { TopicPorts } from './registry.ts'

/** What a Topic's Conversation is made with besides the database and the conversation registry. */
type TopicKit = {
  readonly capabilities: CapabilityProfiles
  readonly chats: ChatDirectory
  readonly memories: ChatMemories
  /** A passive write into a chat, under its admission lock and with its receipt (`Conversations.writeEntry`). */
  readonly write: (chat: string, requestId: string, entry: EntryDraft) => Promise<unknown>
}

/**
 * A Topic's Conversation in Pi and the chat registry (ADR 0032): a new top-level Pi session configured like Personal's
 * (`ConversationRegistry.openConversation`), listed with role `conversation`, Personal's switches and its Topic's name,
 * its memory turned on, and its title following the Topic's renames.
 */
export function topicPorts(
  db: DrizzleSqliteDODatabase,
  conversations: ConversationRegistry,
  kit: TopicKit,
): TopicPorts {
  return {
    open: () => conversations.openConversation(),
    register: (chat, topic, name, now) => {
      registerChat(db, {
        chatId: chat,
        role: 'conversation',
        kind: 'main',
        title: name,
        topicId: topic,
        createdAt: now,
      })
      kit.capabilities.copy(kit.chats.primary(), chat, now)
      conversations.touched([chat])
    },
    activate: (chat) => kit.memories.activate(chat),
    seed: async (chat, operationId, seed) => {
      await kit.write(chat, `topic-seed:${operationId}`, {
        kind: 'app.topic_seed',
        data: { brief: seed.brief, sources: seed.sources.map((source) => ({ ...source })) },
        model: [{ role: 'user', content: topicSeedContent(seed), timestamp: Date.now() }],
      })
    },
    retitle: (chat, name) => {
      db.update(appConversations)
        .set({ title: name })
        .where(and(eq(appConversations.chatId, chat), eq(appConversations.role, 'conversation')))
        .run()
      conversations.touched([chat])
    },
  }
}
