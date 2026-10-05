import * as Effect from 'effect/Effect'
import { expect } from 'vitest'

/** Uses the existing native stack so fixture cases never race a second harness for its port. */
export function routineEventsCase(url: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/routine-events?name=routine-events-${Date.now()}`),
    )
    const responseBody = yield* Effect.promise(() => response.text())
    expect(response.status, responseBody).toBe(200)
    const result: unknown = JSON.parse(responseBody)
    expect(result).toMatchObject({
      noDraftSubscription: true,
      active: 'active',
      shared: true,
      leavingSharedKeptRemote: true,
      bad: 400,
      received: 204,
      replayOneRun: true,
      metadataSealed: true,
      scrubbedMetadata: true,
      metadataLabelled: true,
      spacedOneRun: true,
      pendingLatest: true,
      pendingReplayNoop: true,
      globalSpacing: true,
      invalidArgumentsRejected: true,
      drainedActive: true,
      gapNoModel: true,
      pollRecovery: true,
      terminatedPaused: true,
      resumed: true,
      freshRevision: true,
      revisedReplayNoop: true,
      oldPendingGone: true,
      editedNoBinding: true,
      noStaleRun: true,
    })
  })
}
