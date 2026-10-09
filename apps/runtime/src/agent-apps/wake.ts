import { writeLine } from '../observability/logger.ts'
import { framesOf, safeErrorType } from '../observability/report.ts'
import type { AppJobs, JobSlot } from './jobs.ts'

/**
 * On start, the apps' stored and armed job schedules are made to match again. A failure never fails the start: it is
 * reported with its type and stack locations (never its message), and the next activation or start reconciles again.
 */
export async function reconcileAppJobs(apps: { readonly jobs: Pick<AppJobs, 'reconcile'> }): Promise<void> {
  await apps.jobs.reconcile().catch((error: unknown) =>
    writeLine('error', {
      event: 'failure',
      where: 'agent-apps.reconcile',
      'error.type': safeErrorType(error),
      frames: error instanceof Error ? framesOf(error) : [],
      severity: 'Error',
    }),
  )
}

/** An agent app's job is due (`runAppJob`, ADR 0021). */
export async function runAppJob(apps: { readonly jobs: Pick<AppJobs, 'fire'> }, slot: JobSlot): Promise<void> {
  await apps.jobs.fire(slot)
}
