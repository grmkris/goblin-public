import { drizzle } from 'drizzle-orm/durable-sqlite'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { RoutineStore } from '../../src/routines/store.ts'
import type { RoutineDefinition } from '@purrable/contracts'
import {
  appRoutines,
  appRoutineOperations,
  appRoutineRuns,
  appRoutineSettings,
  appRoutineUsage,
  appSubmissionOrigins,
  appInteractions,
} from '../../src/storage/routines.ts'

const definition: RoutineDefinition = {
  title: 'Morning plan',
  prompt: 'Summarize my priorities.',
  trigger: { kind: 'cron', expression: '0 9 * * 1-5' },
  timezone: 'Europe/Berlin',
  notifyTelegram: false,
  allowedTools: [{ serverId: 'myplan', name: 'workspace_read' }],
  budget: { tokensPerRun: 25_000, tokensPerDay: 50_000, runtimeSeconds: 900 },
}
const rejected = (call: () => unknown) => {
  try {
    call()
    return false
  } catch {
    return true
  }
}
/** Real Durable Object SQLite migration, replay and revision checks; no fake storage. */
export function routinesProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const at = Date.parse('2026-10-05T06:00:00Z')
  const store = new RoutineStore(db, 'owner')
  const first = store.propose(definition, 'proposal-1', 'rt_fixture', at)
  const replay = store.propose(definition, 'proposal-1', 'rt_unused', at)
  const changedId = rejected(() =>
    store.propose({ ...definition, prompt: 'Different instructions.' }, 'proposal-1', 'rt_unused', at),
  )
  const confirmed = store.confirm(first.routine.id, 1, 'confirm-1', at)
  const confirmedReplay = store.confirm(first.routine.id, 1, 'confirm-1', at + 1000)
  const edited = store.edit(first.routine.id, 1, { ...definition, title: 'Updated plan' }, 'edit-1', at + 2000)
  const stale = rejected(() => store.confirm(first.routine.id, 1, 'confirm-stale', at + 3000))
  const foreign = rejected(() => new RoutineStore(db, 'other-owner').get(first.routine.id))
  const reconstructed = new RoutineStore(drizzle(storage), 'owner')
  const paused = reconstructed.pause(first.routine.id, 2, 'pause-1', at + 4000)
  const cap = rejected(() => reconstructed.settingsUpdate('UTC', 21, 2))
  runApplicationMigrations(storage)
  return {
    replay: first.routine.id === replay.routine.id,
    changedId,
    stale,
    foreign,
    cap,
    confirmationReplay: confirmed.routine.confirmedAt === confirmedReplay.routine.confirmedAt,
    confirmed: confirmed.routine.state,
    nextFire: confirmed.routine.nextFireAt,
    editCleared:
      edited.routine.confirmedAt === null && edited.routine.state === 'proposed' && edited.routine.revision === 2,
    paused: paused.routine.state,
    definitions: db.select().from(appRoutines).all().length,
    operations: db.select().from(appRoutineOperations).all().length,
    settings: db.select().from(appRoutineSettings).all(),
    emptyRunStores: [
      db.select().from(appRoutineRuns).all().length,
      db.select().from(appRoutineUsage).all().length,
      db.select().from(appSubmissionOrigins).all().length,
      db.select().from(appInteractions).all().length,
    ],
  }
}
