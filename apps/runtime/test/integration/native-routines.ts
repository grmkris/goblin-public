import * as Schema from 'effect/Schema'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { URL as FileURL } from 'node:url'
import { expect } from 'vitest'
import { type NativeCase, type Phase, evict, freshName, matchCase, probeCase, probeOf } from './native-case.ts'

const BudgetOutage = Schema.Struct({
  blocked: Schema.String,
  recovered: Schema.String,
  failedCopy: Schema.String,
  spentCopy: Schema.String,
})

const RoutineRecovery = Schema.Struct({
  instance: Schema.String,
  runId: Schema.String,
  sessionId: Schema.String,
  used: Schema.Number,
})
const RoutineRecovered = Schema.Struct({
  ...RoutineRecovery.fields,
  state: Schema.String,
  usedBefore: Schema.Number,
  replay: Schema.Boolean,
  reportAccepted: Schema.Boolean,
  retainedSchedules: Schema.Number,
})
const RecoveryEvidence = Schema.Struct({ ...RoutineRecovery.fields, name: Schema.String, testProcess: Schema.Number })
const routineRecoveryPath = new FileURL('../../.alchemy/goblin-routine-reconstruction.json', import.meta.url)

/**
 * A routine waiting on its question survives eviction: the same run and Pi session go on, its usage is projected once,
 * and its report is accepted. In the `write` phase the evidence is kept for the second process instead.
 */
async function recoveryChecks(base: string, phase: Phase): Promise<void> {
  const name = freshName('routine-recovery')
  const before = await probeOf(base, 'routine-recovery-write', RoutineRecovery, name)
  if (phase === 'write') {
    mkdirSync(new FileURL('./', routineRecoveryPath), { recursive: true })
    writeFileSync(routineRecoveryPath, JSON.stringify({ name, testProcess: process.pid, ...before }))
    return
  }
  await evict(base, name)
  const after = await probeOf(base, 'routine-recovery-read', RoutineRecovered, name)
  expect(after.instance).not.toBe(before.instance)
  expect(after).toMatchObject({
    runId: before.runId,
    sessionId: before.sessionId,
    usedBefore: before.used,
    used: 30,
    state: 'completed',
    replay: true,
    reportAccepted: true,
  })
  expect(after.retainedSchedules).toBeLessThanOrEqual(1)
}

/** The second process reads the question the first left waiting, in the same run and Pi session. */
async function recoveredChecks(base: string): Promise<void> {
  const before = Schema.decodeUnknownSync(RecoveryEvidence)(JSON.parse(readFileSync(routineRecoveryPath, 'utf8')))
  expect(process.pid).not.toBe(before.testProcess)
  const after = await probeOf(base, 'routine-recovery-read', RoutineRecovered, before.name)
  expect(after.instance).not.toBe(before.instance)
  expect(after).toMatchObject({
    runId: before.runId,
    sessionId: before.sessionId,
    usedBefore: 15,
    used: 30,
    state: 'completed',
    replay: true,
    reportAccepted: true,
  })
  expect(after.retainedSchedules).toBeLessThanOrEqual(1)
}

/** Definitions, Events, notifications, recovery, usage and budget, Stop, runs, questions and schedules. */
export const routineCases = (phase: Phase): readonly NativeCase[] => [
  matchCase('routine definitions retain exact confirmations, replay IDs and revision fences', 'routines', (result) =>
    expect(result).toMatchObject({
      replay: true,
      changedId: true,
      stale: true,
      foreign: true,
      cap: true,
      confirmationReplay: true,
      confirmed: 'activating',
      nextFire: Date.parse('2026-10-05T07:00:00Z'),
      editCleared: true,
      paused: 'paused',
      definitions: 1,
      operations: 4,
      emptyRunStores: [0, 0, 0, 0],
      settings: [{ id: 1, timezone: 'UTC', maxActive: 20, maxRunning: 2 }],
    }),
  ),
  matchCase(
    'signed routine Events freeze metadata, dedupe and coalesce, recover gaps and retire revisions',
    'routine-events',
    (result) =>
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
      }),
  ),
  matchCase(
    "a notice's Telegram copy: frozen channel and bytes, retried once, its remote receipt kept apart (ADR 0041)",
    'routine-notifications',
    (result) =>
      expect(result).toMatchObject({
        offCalls: 0,
        frozenServer: 'mygram',
        retryState: 'pending',
        attempts: 2,
        stableBytes: true,
        escaped: 'Sidequest: Picked &lt;safe&gt;',
        accepted: 1,
        state: 'accepted',
        metadata: { id: 'fixture-remote-id', delivery: 'accepted' },
      }),
  ),
  {
    title: 'routine question survives eviction with the same Pi session and one usage projection',
    run: (base) => recoveryChecks(base, phase),
  },
  ...(phase === 'read'
    ? [
        {
          title: 'routines recover the retained question and same Pi session',
          secondProcess: true,
          run: recoveredChecks,
        } as const,
      ]
    : []),
  matchCase(
    'routines charge committed native compaction, dedupe UTC-day replay and bound cap overshoot',
    'routine-usage',
    (result) =>
      expect(result).toMatchObject({
        compactionStatus: 'completed',
        compactedTokens: 45,
        afterReplay: 45,
        nextDay: 0,
        capState: 'failed',
        overshoot: 10,
        capModelRequests: 1,
      }),
  ),
  // While auth D1 cannot answer, the budget hook blocks a tool in main as a check that failed, never as a spent
  // budget; once the plan reads again, the tool runs.
  probeCase(
    'a budget check auth D1 cannot answer blocks the tool as failed, not as a spent budget',
    'budget-outage',
    BudgetOutage,
    (result) => {
      expect(result.blocked).toContain(result.failedCopy)
      expect(result.blocked).not.toContain(result.spentCopy)
      expect(result.recovered).not.toContain(result.failedCopy)
      expect(result.recovered).toContain('routines')
    },
  ),
  matchCase(
    'main Stop preserves executing routines, caps queue one trigger and archive stops owned work',
    'routine-stop',
    (result) =>
      expect(result).toMatchObject({
        currentConfirmation: 'active',
        mainStopPreserved: true,
        capped: true,
        noCapRun: true,
        onePending: true,
        suppressed: 2,
        archived: 'archived',
        archivedState: 'stopped',
        pendingCleared: true,
        secondSettled: 'completed',
        oneReport: true,
      }),
  ),
  matchCase(
    'routine manual runs isolate native Pi sessions and dedupe passive reports [canary]',
    'routine-execution',
    (result) =>
      expect(result).toMatchObject({
        duplicate: true,
        state: 'completed',
        registered: true,
        copiedCapabilities: 0,
        reportCount: 1,
        reportAccepted: true,
        tools: ['mcp_list', 'mcp_call', 'ask_user'],
        usage: { run: 15, day: 15 },
        skipped: 'skipped',
        skipOutcome: 'ResidentInactive',
        noSkippedModel: true,
      }),
  ),
  matchCase(
    'routine questions release slots and resume only with correlated owner answers',
    'routine-question',
    (result) =>
      expect(result).toMatchObject({
        mainStopPreserved: true,
        answered: true,
        replay: true,
        changedRejected: true,
        sameSession: true,
        answeredState: 'completed',
        answeredInteractions: ['answered'],
        lateRejected: true,
        expiredState: 'stopped',
      }),
  ),
  matchCase(
    'native dated routine alarms dedupe and collapse cron downtime before rearming',
    'routine-schedule',
    (result) =>
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
      }),
  ),
]
