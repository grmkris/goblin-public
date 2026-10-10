import { and, eq } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import { copyExclusions } from '../capabilities/profiles.ts'
import { primaryChat, registerChat } from '../chats/directory.ts'
import type { Conversations } from '../chats/service.ts'
import type { Memories } from '../memory/service.ts'
import type { Db } from '../runtime/db.ts'
import { appConversations } from '../storage/schema.ts'
import { topicSeedContent } from '../pi/content.ts'
import type { TopicPorts } from './registry.ts'

/** What a Topic's Conversation is made with besides the database: the conversation services and the memories. */
type TopicKit = {
  readonly conversations: Conversations['Service']
  readonly memories: Memories['Service']
}

/**
 * A Topic's Conversation in Pi and the chat registry (ADR 0032): a new top-level Pi session whose tool filter follows its
 * setup's subagents (`Conversations.openConversation`, ADR 0040), listed with role `conversation`, Personal's switches
 * and its Topic's name, its
 * memory turned on, and its title following the Topic's renames. A seed is a passive write into it
 * (`Conversations.writeEntry`), under its admission lock and with its receipt.
 */
export function topicPorts(db: Db['Service'], kit: TopicKit): TopicPorts {
  return {
    open: (setup) => kit.conversations.openConversation(setup.subagents),
    register: (chat, topic, name, now) => {
      registerChat(db, {
        chatId: chat,
        role: 'conversation',
        kind: 'main',
        title: name,
        topicId: topic,
        createdAt: now,
      })
      copyExclusions(db, primaryChat, chat, now)
    },
    retitle: (chat, name) => {
      db.update(appConversations)
        .set({ title: name })
        .where(and(eq(appConversations.chatId, chat), eq(appConversations.role, 'conversation')))
        .run()
    },
    touched: kit.conversations.touched,
    activate: kit.memories.activate,
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
