import type { Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { Routines, RoutineRuns, attempt, attemptSync } from '../services.ts'
import type { RoutineRevision } from '@purrable/contracts'
import { changeRoutine } from './program.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'
import { askingExtension } from '../pi/ask-user.ts'
import { personaExtension } from '../pi/persona.ts'
import { routineBudgetExtension } from '../pi/routine-budget.ts'
import { routineRunExtension } from '../pi/routine-run.ts'
import { CredentialCipher } from '../mcp/cipher.ts'
import { RoutineRunner, type StartRun } from './runner.ts'
import { RoutineScheduler, type RoutineSchedules, type RoutineSlot } from './scheduler.ts'
import type { RoutineRun } from './runs.ts'

export function routineExtensions(run: RunProgram, resident: Extension, key: string) {
  const asking = askingExtension(async (session, callId, questions) => {
    const cipher = await CredentialCipher.fromBase64(key)
    await run(
      Effect.gen(function* () {
        const store = yield* RoutineRuns
        const at = yield* Clock.currentTimeMillis
        yield* attempt(() => store.ask(session, callId, questions, cipher, at))
      }),
    )
  })
  const budget = routineBudgetExtension(run)
  const task = routineRunExtension(run, [personaExtension, resident, asking, budget])
  return { start: task.start, extra: [task.extension, asking, budget] }
}

type Input = { storage: DurableObjectStorage; owner: () => string; key: string; schedules: RoutineSchedules }
export function routineSchedulePorts(input: {
  list: RoutineSchedules['list']
  cancel: RoutineSchedules['cancel']
  wake: RoutineSchedules['wake']
  armNative: (at: Date, payload: RoutineSlot) => Promise<{ id: string }>
  deadlineNative: (at: Date, payload: { runId: string }) => Promise<unknown>
}): RoutineSchedules {
  return {
    list: input.list,
    cancel: input.cancel,
    wake: input.wake,
    arm: async (at, payload) => (await input.armNative(new Date(Math.ceil(at / 1000) * 1000), payload)).id,
    deadline: async (runId, at) => {
      await input.deadlineNative(new Date(Math.ceil(at / 1000) * 1000), { runId })
    },
  }
}
export const routineChangeProgram = (
  routines: RoutineController,
  id: string,
  input: RoutineRevision,
  action: 'confirm' | 'pause' | 'archive',
) =>
  Effect.gen(function* () {
    yield* changeRoutine(id, input, action)
    if (action === 'archive') yield* attempt(() => routines.archive(id))
    yield* attempt(() => routines.reconcile())
    return yield* Routines.use((store) => attemptSync(() => store.view(id)))
  })
/** Keeps the Agent shell thin while the native scheduler and Pi own their respective lifecycle boundaries. */
export class RoutineController extends RoutineRunner {
  readonly #input: Input
  #scheduler: RoutineScheduler | undefined
  constructor(run: RunProgram, harness: PiHarness, start: StartRun, input: Input) {
    super(run, harness, start, input.schedules.wake)
    this.#input = input
  }
  #scheduled(): RoutineScheduler {
    const { storage, owner, schedules, key } = this.#input
    this.#scheduler ??= new RoutineScheduler(storage, owner, this, schedules, key)
    return this.#scheduler
  }
  reconcile() {
    return this.#scheduled().reconcile()
  }
  override async start(record: RoutineRun, answer?: { operationId: string; text: string }): Promise<string> {
    await this.#input.schedules.deadline(record.id, record.deadlineAt)
    return super.start(record, answer)
  }
  fire(slot: RoutineSlot) {
    return this.#scheduled().fire(slot)
  }
  override async maintain(): Promise<void> {
    await super.maintain()
    await this.reconcile()
  }
}
