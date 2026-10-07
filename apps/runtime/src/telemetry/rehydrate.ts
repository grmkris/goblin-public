import { LiveDoc, type Harness } from '@earendil-works/pi-durable'
import { conversationId, type PiContext } from '../pi/context.ts'

export type RehydratedTelemetry = {
  readonly operations: ReadonlyMap<string, string>
  readonly runs: ReadonlyMap<string, { readonly taskId: string; readonly inputs: readonly string[] }>
}

async function activeRuns(harness: Harness, ids: readonly string[], context: PiContext) {
  const runs = new Map<string, { readonly taskId: string; readonly inputs: readonly string[] }>()
  for (const conversation of ids) {
    const live = await harness.snapshot(LiveDoc, conversationId(conversation), context)
    if (live?.run === undefined) continue
    runs.set(conversation, { taskId: String(live.run.taskId), inputs: live.run.inputs.map(String) })
  }
  return runs
}

/** Reads durable Pi inspection after open; no commit listener calls Pi or waits on it. */
export async function rehydrateTelemetry(harness: Harness, context: PiContext): Promise<RehydratedTelemetry> {
  const inspection = await harness.inspect(context)
  const operations = new Map(
    inspection.submissions.flatMap((submission) =>
      submission.requestId === undefined ? [] : [[String(submission.id), submission.requestId] as const],
    ),
  )
  const ids = [...new Set(inspection.tasks.map(({ record }) => String(record.conversationId)))]
  return { operations, runs: await activeRuns(harness, ids, context) }
}
