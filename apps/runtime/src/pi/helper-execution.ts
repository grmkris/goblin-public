import type { Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { appConversations } from '../storage/schema.ts'
import { BACKGROUND, conversationId } from './context.ts'

/** Registered helpers use the current execution extensions, including after a retained-object reconstruction. */
export async function restoreHelperExecution(
  db: DrizzleSqliteDODatabase,
  harness: PiHarness,
  extensions: readonly Extension[],
): Promise<void> {
  const helpers = db.select().from(appConversations).where(eq(appConversations.kind, 'subagent')).all()
  if (helpers.length === 0) return
  const pi = await harness.pi()
  const names = extensions.map((extension) => extension.name).join('\n')
  for (const helper of helpers) {
    const conversation = await pi.conversation(conversationId(helper.chatId), BACKGROUND)
    if (conversation === undefined) continue
    const current = await conversation.agent(BACKGROUND)
    if (current.extensions.map((extension) => extension.name).join('\n') !== names)
      await conversation.configure({ extensions }, BACKGROUND)
  }
}
