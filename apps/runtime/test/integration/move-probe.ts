import type { PiHarness } from 'agents/harness/pi'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { ChatDirectory } from '../../src/chats/directory.ts'
import { BACKGROUND, conversationId } from '../../src/pi/context.ts'
import { eq } from 'drizzle-orm'
import { appChatMemoryLog } from '../../src/storage/chat-memory.ts'
import { appChatMoves, appConversations } from '../../src/storage/schema.ts'

/**
 * What a move left behind, read from the object's own storage: its rows, the chats, Personal's memory log and the Pi
 * sessions there are.
 */
export async function moveState(harness: PiHarness, db: DrizzleSqliteDODatabase) {
  return {
    moves: db.select().from(appChatMoves).all(),
    chats: db
      .select({
        id: appConversations.chatId,
        session: appConversations.piSession,
        parent: appConversations.parentSession,
        spawner: appConversations.spawnerSession,
        kind: appConversations.kind,
        recallThrough: appConversations.recallThrough,
        epoch: appConversations.epoch,
      })
      .from(appConversations)
      .all(),
    memory: db
      .select({ entry: appChatMemoryLog.entryId })
      .from(appChatMemoryLog)
      .where(eq(appChatMemoryLog.chatId, '1'))
      .all()
      .map((row) => row.entry),
    sessions: (await harness.sessions.list()).length,
  }
}

/**
 * `rounds` reads of a chat's current Pi session, its newest 50 entries and its model context each time, so the
 * caller can time them from outside (workerd's clock stands still while a request computes).
 */
export async function readRounds(harness: PiHarness, chats: ChatDirectory, chat: string, rounds: number) {
  const conversation = await (await harness.pi()).conversation(conversationId(chats.session(chat)), BACKGROUND)
  if (conversation === undefined) throw new Error('conversation missing')
  let entries = 0
  let messages = 0
  for (let round = 0; round < rounds; round++) {
    entries = (await conversation.entries({}, 50, undefined, BACKGROUND)).items.length
    messages = (await conversation.context(BACKGROUND)).messages.length
  }
  return { entries, messages }
}
