import { eq, inArray } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import {
  appAgentApps,
  appAgentArtifacts,
  appAgentEvents,
  appAgentJobs,
  appAgentPowers,
  appAgentReceipts,
  appAgentReleases,
  appAgentSnapshots,
  appAgentState,
  appAgentUsage,
  appAgentViews,
} from '../storage/schema.ts'

/**
 * Deletes every row of one agent app in one transaction (ADR 0021): its releases with their code and views, state,
 * snapshots, receipts, events, powers, usage, schedules and the app itself. Its files and native schedules go first,
 * outside SQLite's transaction.
 */
export function eraseApp(db: DrizzleSqliteDODatabase, app: string): void {
  db.transaction((tx) => {
    const releases = tx
      .select({ id: appAgentReleases.id })
      .from(appAgentReleases)
      .where(eq(appAgentReleases.app, app))
      .all()
      .map((row) => row.id)
    if (releases.length > 0) {
      tx.delete(appAgentArtifacts).where(inArray(appAgentArtifacts.release, releases)).run()
      tx.delete(appAgentViews).where(inArray(appAgentViews.release, releases)).run()
    }
    tx.delete(appAgentReleases).where(eq(appAgentReleases.app, app)).run()
    tx.delete(appAgentState).where(eq(appAgentState.app, app)).run()
    tx.delete(appAgentSnapshots).where(eq(appAgentSnapshots.app, app)).run()
    tx.delete(appAgentReceipts).where(eq(appAgentReceipts.app, app)).run()
    tx.delete(appAgentEvents).where(eq(appAgentEvents.app, app)).run()
    tx.delete(appAgentPowers).where(eq(appAgentPowers.app, app)).run()
    tx.delete(appAgentUsage).where(eq(appAgentUsage.app, app)).run()
    tx.delete(appAgentJobs).where(eq(appAgentJobs.app, app)).run()
    tx.delete(appAgentApps).where(eq(appAgentApps.name, app)).run()
  })
}
