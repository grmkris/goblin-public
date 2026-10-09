import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
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
      publicTokensPreserved: true,
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

export function routineSchedulingCase(url: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/routine-schedule?name=routine-schedule-${Date.now()}`),
    )
    expect(response.status).toBe(200)
    const result = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      duplicateScheduleCount: 1,
      earlierWakeRetained: true,
      recurringWakeRetained: true,
      nativeReminderCompleted: true,
      onceCount: 1,
      onceState: 'completed',
      cronCount: 1,
      missed: 4,
      nextFuture: true,
      editedState: 'proposed',
      staleRevisionKeptRuns: true,
    })
  })
}

/** As native.test.ts fetches its probes: one connection per request. */
const CLOSE = { headers: { connection: 'close' } }

/** Routine usage: committed native compaction is charged, UTC-day replay dedupes and a cap overshoot stays bounded. */
export function routineUsageCase(url: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/routine-usage?name=routine-usage-${Date.now()}`, CLOSE),
    )
    expect(response.status).toBe(200)
    const result: unknown = yield* Effect.promise(() => response.json())
    expect(result).toMatchObject({
      compactionStatus: 'completed',
      compactedTokens: 45,
      afterReplay: 45,
      nextDay: 0,
      capState: 'failed',
      overshoot: 10,
      capModelRequests: 1,
    })
  })
}

const BudgetOutage = Schema.Struct({
  blocked: Schema.String,
  recovered: Schema.String,
  failedCopy: Schema.String,
  spentCopy: Schema.String,
})

/**
 * R1: while auth D1 cannot answer, the budget hook blocks a tool in main as a check that failed, never as a spent
 * budget; once the plan reads again, the tool runs.
 */
export function budgetOutageCase(url: string) {
  return Effect.gen(function* () {
    const response = yield* Effect.promise(() =>
      fetch(`${url.replace(/\/+$/u, '')}/budget-outage?name=budget-outage-${Date.now()}`, CLOSE),
    )
    const body = yield* Effect.promise(() => response.text())
    expect(response.status, body).toBe(200)
    const result = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(BudgetOutage))(body)
    expect(result.blocked).toContain(result.failedCopy)
    expect(result.blocked).not.toContain(result.spentCopy)
    expect(result.recovered).not.toContain(result.failedCopy)
    expect(result.recovered).toContain('routines')
  })
}
