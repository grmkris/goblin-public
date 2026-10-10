import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { CapabilityProfiles } from '../capabilities/profiles.ts'
import { registerChat } from '../chats/directory.ts'
import type { Chats, Conversations } from '../chats/service.ts'
import { attempt } from '../http/errors.ts'
import type { ChatMemories } from '../memory/memory.ts'
import type { Db } from '../runtime/db.ts'
import { appConversations } from '../storage/schema.ts'
import { topicSeedContent } from '../pi/content.ts'
import type { TopicPorts } from './registry.ts'

/** What a Topic's Conversation is made with besides the database: the conversation services, profiles and memory. */
type TopicKit = {
  readonly conversations: Conversations['Service']
  readonly chats: Chats['Service']
  readonly capabilities: CapabilityProfiles
  readonly memories: ChatMemories
}

/**
 * A Topic's Conversation in Pi and the chat registry (ADR 0032): a new top-level Pi session configured like Personal's
 * (`Conversations.openConversation`), listed with role `conversation`, Personal's switches and its Topic's name, its
 * memory turned on, and its title following the Topic's renames. A seed is a passive write into it
 * (`Conversations.writeEntry`), under its admission lock and with its receipt.
 */
export function topicPorts(db: Db['Service'], kit: TopicKit): TopicPorts {
  return {
    open: kit.conversations.openConversation,
    register: (chat, topic, name, now) => {
      registerChat(db, {
        chatId: chat,
        role: 'conversation',
        kind: 'main',
        title: name,
        topicId: topic,
        createdAt: now,
      })
      kit.capabilities.copy(kit.chats.primary, chat, now)
    },
    retitle: (chat, name) => {
      db.update(appConversations)
        .set({ title: name })
        .where(and(eq(appConversations.chatId, chat), eq(appConversations.role, 'conversation')))
        .run()
    },
    touched: kit.conversations.touched,
    activate: (chat) => attempt(() => kit.memories.activate(chat)),
    seed: (chat, operationId, seed) =>
      Effect.asVoid(
        kit.conversations.writeEntry(chat, `topic-seed:${operationId}`, {
          kind: 'app.topic_seed',
          data: { brief: seed.brief, sources: seed.sources.map((source) => ({ ...source })) },
          model: [{ role: 'user', content: topicSeedContent(seed), timestamp: Date.now() }],
        }),
      ),
  }
}
