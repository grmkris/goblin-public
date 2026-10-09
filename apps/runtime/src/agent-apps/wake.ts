import type { AgentApps } from './engine.ts'
import { type JobSlot, logAppJobs } from './jobs.ts'

/** On start, the apps' stored and armed job schedules are made to match again; a failure is logged, never thrown. */
export async function reconcileAppJobs(apps: AgentApps): Promise<void> {
  await apps.jobs.reconcile().catch((error: unknown) => logAppJobs(error))
}

/** An agent app's job is due (`runAppJob`, ADR 0021). */
export async function runAppJob(apps: AgentApps, slot: JobSlot): Promise<void> {
  await apps.jobs.fire(slot)
}
