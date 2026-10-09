import { ROOT_CONVERSATION_ID } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { and, eq } from 'drizzle-orm'
import { PRIMARY_CHAT } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { registerPrimary } from '../../src/chats/directory.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { appConversations } from '../../src/storage/schema.ts'

export const profileEnabled = Schema.is(Schema.Struct({ PRIMARY_PROFILE: Schema.Literal('permuted') }))

/** Test-only boot seam: bind the primary chat to a fresh non-root Pi session before services compose. */
export async function permutePrimary(storage: DurableObjectStorage, harness: PiHarness): Promise<void> {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  registerPrimary(db, Math.floor(Date.now() / 1000))
  const before = db.select().from(appConversations).where(eq(appConversations.chatId, PRIMARY_CHAT)).get()
  if (before?.piSession === null || before === undefined) throw new Error('primary binding missing')
  if (before.epoch === 1 && before.piSession !== String(ROOT_CONVERSATION_ID)) return
  if (before.piSession !== String(ROOT_CONVERSATION_ID) || before.epoch !== 0)
    throw new Error('unexpected primary binding at boot')
  const fresh = await harness.sessions.create()
  db.update(appConversations)
    .set({ piSession: fresh.id, epoch: 1 })
    .where(
      and(
        eq(appConversations.chatId, PRIMARY_CHAT),
        eq(appConversations.piSession, String(ROOT_CONVERSATION_ID)),
        eq(appConversations.epoch, 0),
      ),
    )
    .run()
  const after = db.select().from(appConversations).where(eq(appConversations.chatId, PRIMARY_CHAT)).get()
  if (after?.piSession !== fresh.id || after.epoch !== 1) throw new Error('permuted primary did not rebind')
  if ((await harness.messages({ session: String(ROOT_CONVERSATION_ID) })).length !== 0)
    throw new Error('permuted primary root transcript is not empty')
}
