import type { PersonalAgent } from '../../src/agent.ts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import type { RoutineDefinition } from '@goblin/contracts'
import { changeRoutine, editRoutine, proposeRoutine } from './routines-owner.ts'
import { appRoutines } from '../../src/storage/routines.ts'
import { RoutineStore } from '../../src/routines/store.ts'
import { RoutineRunStore } from '../../src/routines/runs.ts'
import { type Probes, inAgent } from './probe.ts'
import { until } from './until.ts'

const definition: RoutineDefinition = {
  title: 'Native dated reminder',
  prompt: 'Return a short reminder.',
  timezone: 'UTC',
  trigger: { kind: 'once', at: '2030-01-01T00:00:00Z' },
  notifyTelegram: false,
  allowedTools: [],
  budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
}
async function confirmed(agent: PersonalAgent, input: RoutineDefinition, operationId: string) {
  const draft = await proposeRoutine(agent, input, `${operationId}-propose`)
  const command = { revision: 1, operationId: `${operationId}-confirm` }
  await changeRoutine(agent, draft.id, command, 'confirm')
  await changeRoutine(agent, draft.id, command, 'confirm')
  return draft.id
}

async function cancelWakes(agent: PersonalAgent) {
  for (const job of await agent.listSchedules()) if (job.callback === 'routinesWake') await agent.cancelSchedule(job.id)
}
async function recurringWake(agent: PersonalAgent): Promise<boolean> {
  await cancelWakes(agent)
  await agent.schedule(new Date(Date.now() + 500), 'routinesWake', { at: Date.now() }, { idempotent: true })
  const retained = await until(
    async () =>
      (await agent.listSchedules()).some(
        (job) => job.callback === 'routinesWake' && job.time > Math.floor(Date.now() / 1000) + 10,
      ),
    (found) => found,
    4000,
  )
  await cancelWakes(agent)
  return retained
}

/** Uses the native alarm for the reminder; later callbacks exercise app watermarks and edit fences. */
async function routineScheduleProbe(storage: DurableObjectStorage, agent: PersonalAgent) {
  const db = drizzle(storage)
  const routines = new RoutineStore(db, agent.name)
  const runs = new RoutineRunStore(db, agent.name)
  const firedAt = Date.now() + 1500
  const onceId = await confirmed(
    agent,
    { ...definition, trigger: { kind: 'once', at: new Date(firedAt).toISOString() } },
    'once',
  )
  const jobs = await agent.listSchedules()
  const duplicateScheduleCount = jobs.filter((job) => job.callback === 'runRoutine').length
  await until(
    () => runs.list(onceId),
    (list) => list.some((run) => run.state === 'completed'),
  )
  const before = runs.list(onceId)
  await agent.runRoutine({ routineId: onceId, revision: 1, firedAt })
  const once = runs.list(onceId)
  const cron = { ...definition, title: 'Native cron', trigger: { kind: 'cron' as const, expression: '*/15 * * * *' } }
  const cronId = await confirmed(agent, cron, 'cron')
  const recurringWakeRetained = await recurringWake(agent)
  const later = Date.now() + 3_600_000
  await agent.schedule(new Date(later), 'routinesWake', undefined, { idempotent: true })
  await agent.routinesWake()
  const wakes = (await agent.listSchedules()).filter((job) => job.callback === 'routinesWake')
  const first = Math.floor(Date.now() / 900_000) * 900_000 - 3_600_000
  db.update(appRoutines).set({ nextFireAt: first }).where(eq(appRoutines.id, cronId)).run()
  await agent.runRoutine({ routineId: cronId, revision: 1, firedAt: first })
  await agent.runRoutine({ routineId: cronId, revision: 1, firedAt: first })
  const collapsed = routines.get(cronId)
  const current = collapsed.nextFireAt
  await editRoutine(agent, cronId, {
    revision: 1,
    operationId: 'edit-cron',
    definition: { ...cron, prompt: 'Changed draft instructions.' },
  })
  if (current !== null) await agent.runRoutine({ routineId: cronId, revision: 1, firedAt: current })
  const after = runs.list(cronId)
  return {
    duplicateScheduleCount,
    recurringWakeRetained,
    earlierWakeRetained: wakes.length === 1 && (wakes[0]?.time ?? Number.MAX_SAFE_INTEGER) < later / 1000,
    nativeReminderCompleted: before.length === 1 && before[0]?.state === 'completed',
    onceCount: once.length,
    onceState: routines.get(onceId).state,
    cronCount: after.length,
    missed: collapsed.missedCount,
    nextFuture: current !== null && current > Date.now(),
    editedState: routines.get(cronId).state,
    staleRevisionKeptRuns: after.length === 1,
  }
}

export const probes: Probes = {
  'routine-schedule': inAgent(({ storage, agent }) => routineScheduleProbe(storage, agent)),
}
