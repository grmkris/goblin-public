import type { PersonalAgent } from '../../src/agent.ts'
import { PRIMARY_CHAT, type RoutineDefinition } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { unwrap } from '../../src/http/rpc.ts'
import { RoutineRunStore } from '../../src/routines/runs.ts'
import { appInteractions, appRoutineRuns, appRoutines } from '../../src/storage/routines.ts'
import { RoutineStore } from '../../src/routines/store.ts'

const question: RoutineDefinition = {
  title: 'Native question',
  prompt: 'call ask_user {"questions":[{"id":"choice","prompt":"What should I use?","kind":"text"}]}',
  trigger: { kind: 'once', at: '2030-01-01T00:00:00Z' },
  timezone: 'UTC',
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
}
async function waitFor(store: RoutineRunStore, id: string, state: string): Promise<void> {
  for (let count = 0; count < 200; count += 1) {
    if (store.get(id).state === state) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Routine did not reach ${state}`)
}
async function startQuestion(agent: PersonalAgent, suffix: string) {
  const definition = {
    ...question,
    budget: { ...question.budget, runtimeSeconds: suffix === 'recovery' ? 1800 : 60 },
    trigger: { kind: 'once' as const, at: new Date(Date.now() + 3_600_000).toISOString() },
  }
  const draft = unwrap(await agent.routinePropose({ operationId: `question-${suffix}`, definition }))
  unwrap(await agent.routineChange(draft.id, { revision: 1, operationId: `confirm-${suffix}` }, 'confirm'))
  return unwrap(await agent.routineRun(draft.id, { revision: 1, operationId: `run-${suffix}`, confirmRun: true }))
}

export async function routineRecoveryWrite(storage: DurableObjectStorage, agent: PersonalAgent) {
  const store = new RoutineRunStore(drizzle(storage), agent.name)
  const run = await startQuestion(agent, 'recovery')
  await waitFor(store, run.id, 'waiting_owner')
  const record = store.get(run.id)
  return { runId: record.id, sessionId: record.sessionId, used: store.used(run.id, Date.now()).run }
}

export async function routineRecoveryRead(storage: DurableObjectStorage, agent: PersonalAgent) {
  const store = new RoutineRunStore(drizzle(storage), agent.name)
  const before = store.live().find((record) => record.state === 'waiting_owner')
  if (!before?.sessionId) throw new Error('Reconstructed routine question missing')
  await agent.routinesWake()
  const usedBefore = store.used(before.id, Date.now()).run
  unwrap(await agent.submit(before.sessionId, 'Resume the recovered routine.', 'recovery-answer'))
  await waitFor(store, before.id, 'completed')
  await agent.routinesWake()
  const after = store.get(before.id)
  const replay = await agent.submit(before.sessionId, 'Resume the recovered routine.', 'recovery-answer')
  return {
    runId: after.id,
    sessionId: after.sessionId,
    state: after.state,
    usedBefore,
    used: store.used(after.id, Date.now()).run,
    replay: replay.ok,
    reportAccepted: after.reportAcceptedAt !== null,
    retainedSchedules: (await agent.listSchedules()).filter((job) => job.callback === 'runRoutine').length,
  }
}

/** Real Pi question termination, same-session owner reply, replay checks and deadline fencing. */
export async function routineQuestionProbe(storage: DurableObjectStorage, agent: PersonalAgent) {
  const db = drizzle(storage)
  const store = new RoutineRunStore(db, agent.name)
  const first = await startQuestion(agent, 'answered')
  await waitFor(store, first.id, 'waiting_owner')
  const record = store.get(first.id)
  if (record.sessionId === null) throw new Error('Question thread missing')
  await agent.stop(PRIMARY_CHAT)
  const mainStopPreserved = store.get(first.id).state === 'waiting_owner'
  const answered = await agent.submit(record.sessionId, 'Use the bounded fixture.', 'question-answer')
  await waitFor(store, first.id, 'completed')
  const replay = await agent.submit(record.sessionId, 'Use the bounded fixture.', 'question-answer')
  const changed = await agent.submit(record.sessionId, 'Different answer.', 'question-answer')
  const late = await startQuestion(agent, 'expired')
  await waitFor(store, late.id, 'waiting_owner')
  const lateSession = store.get(late.id).sessionId
  if (lateSession === null) throw new Error('Late-answer thread missing')
  db.update(appRoutineRuns)
    .set({ deadlineAt: Date.now() - 1 })
    .where(eq(appRoutineRuns.id, late.id))
    .run()
  const rejected = await agent.submit(lateSession, 'Too late.', 'question-late-answer')
  await agent.routinesWake()
  return {
    mainStopPreserved,
    answered: answered.ok,
    replay: replay.ok,
    changedRejected: !changed.ok,
    sameSession: store.get(first.id).sessionId === record.sessionId,
    answeredState: store.get(first.id).state,
    answeredInteractions: db
      .select()
      .from(appInteractions)
      .where(eq(appInteractions.runId, first.id))
      .all()
      .map((row) => row.state),
    lateRejected: !rejected.ok,
    expiredState: store.get(late.id).state,
  }
}

async function slowRoutine(agent: PersonalAgent, suffix: string) {
  const definition = {
    ...question,
    title: `Native slow routine ${suffix}`,
    prompt: 'Return a bounded answer.',
    trigger: { kind: 'cron' as const, expression: '*/15 * * * *' },
  }
  const draft = unwrap(await agent.routinePropose({ operationId: `slow-${suffix}`, definition }))
  const confirmed = unwrap(
    await agent.routineChange(draft.id, { revision: 1, operationId: `slow-confirm-${suffix}` }, 'confirm'),
  )
  return confirmed
}

/** Real delayed model requests let Stop and limits race with an executing background routine. */
export async function routineStopProbe(storage: DurableObjectStorage, agent: PersonalAgent) {
  const db = drizzle(storage)
  const runs = new RoutineRunStore(db, agent.name)
  const routines = new RoutineStore(db, agent.name)
  const definitions = []
  for (const suffix of ['first', 'second', 'third']) definitions.push(await slowRoutine(agent, suffix))
  const firstDefinition = definitions[0]
  const secondDefinition = definitions[1]
  const thirdDefinition = definitions[2]
  if (!firstDefinition || !secondDefinition || !thirdDefinition) throw new Error('Slow definitions missing')
  const first = unwrap(
    await agent.routineRun(firstDefinition.id, { revision: 1, operationId: 'slow-first-run', confirmRun: true }),
  )
  const second = unwrap(
    await agent.routineRun(secondDefinition.id, { revision: 1, operationId: 'slow-second-run', confirmRun: true }),
  )
  await waitFor(runs, first.id, 'running')
  await waitFor(runs, second.id, 'running')
  const capped = await agent.routineRun(thirdDefinition.id, {
    revision: 1,
    operationId: 'slow-third-run',
    confirmRun: true,
  })
  await agent.stop(PRIMARY_CHAT)
  const mainStopPreserved = runs.get(first.id).state === 'running' && runs.get(second.id).state === 'running'
  for (let index = 2; index >= 1; index -= 1) {
    const due = Math.floor(Date.now() / 900_000) * 900_000 - index * 900_000
    db.update(appRoutines).set({ nextFireAt: due }).where(eq(appRoutines.id, firstDefinition.id)).run()
    await agent.runRoutine({ routineId: firstDefinition.id, revision: 1, firedAt: due })
  }
  const pending = routines.get(firstDefinition.id)
  const archived = unwrap(
    await agent.routineChange(firstDefinition.id, { revision: 1, operationId: 'slow-archive' }, 'archive'),
  )
  const archivedState = runs.get(first.id).state
  await waitFor(runs, second.id, 'completed')
  await agent.routinesWake()
  return {
    currentConfirmation: firstDefinition.state,
    mainStopPreserved,
    capped: !capped.ok,
    noCapRun: runs.list(thirdDefinition.id).length === 0,
    onePending: pending.pendingTrigger !== null && runs.list(firstDefinition.id).length === 1,
    suppressed: pending.suppressedCount,
    archived: archived.state,
    archivedState,
    pendingCleared: routines.get(firstDefinition.id).pendingTrigger === null,
    secondSettled: runs.get(second.id).state,
    oneReport: runs.get(first.id).reportAcceptedAt !== null,
  }
}
