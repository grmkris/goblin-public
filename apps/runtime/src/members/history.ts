import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type { Conversation } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import type { MemberPrincipal } from '../env.ts'
import type { MemberAccess } from './access.ts'
import { appMetadata } from '../storage/schema.ts'
import { BACKGROUND, conversationId, entryId } from '../pi/context.ts'

/** Import newly authorized root history as quoted evidence, never into restricted contexts. */
export async function importMemberHistory(
  db: DrizzleSqliteDODatabase,
  harness: PiHarness,
  context: Conversation,
  principal: MemberPrincipal,
  access: MemberAccess,
): Promise<void> {
  if (principal.policy.mainHistory !== 'all') return
  const key = `member-history:${context.id}`
  const through = Number(db.select().from(appMetadata).where(eq(appMetadata.id, key)).get()?.value ?? 0)
  const root = await (await harness.pi()).conversation(conversationId('1'), BACKGROUND)
  const entries = []
  let cursor: Parameters<NonNullable<typeof root>['entries']>[2]
  do {
    const page = await root?.entries({ minEntryId: entryId(through + 1) }, 200, cursor, BACKGROUND)
    await access.verify(principal)
    entries.push(...(page?.items ?? []))
    cursor = page?.next
  } while (cursor !== undefined)
  for (const entry of entries.toReversed()) {
    if (entry.model === undefined) continue
    await access.verify(principal)
    await context.submit(
      {
        type: 'write',
        requestId: `history:${entry.id}`,
        entry: {
          kind: 'app.member_history',
          data: { sourceEntry: entry.id, trust: 'quoted' },
          model: [
            { role: 'user', content: JSON.stringify({ trust: 'quoted', history: entry.model }), timestamp: Date.now() },
          ],
        },
      },
      BACKGROUND,
    )
  }
  if (entries.length > 0) {
    await access.verify(principal)
    const value = String(Math.max(through, ...entries.map((entry) => Number(entry.id))))
    db.insert(appMetadata)
      .values({ id: key, value })
      .onConflictDoUpdate({ target: appMetadata.id, set: { value } })
      .run()
  }
}
