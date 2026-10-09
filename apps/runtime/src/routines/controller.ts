import type { Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { RoutineRuns, attempt } from '../services.ts'
import { RoutineControl, Routines } from './service.ts'
import type { RoutineRevision } from '@goblin/contracts'
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
import type { EventContext } from '../mcp/events/dispatcher.ts'
import { Events } from '../mcp/events.ts'
import { RoutineEventBindings } from './events.ts'

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
  const task = routineRunExtension(run, [personaExtension, resident, asking, budget], key)
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
/** The owner confirms, pauses or archives a routine: confirm subscribes an event routine, archive stops its runs. */
export const routineChange = Effect.fn('routines.change')(function* (
  id: string,
  input: RoutineRevision,
  action: 'confirm' | 'pause' | 'archive',
) {
  const changed = yield* changeRoutine(id, input, action)
  const control = yield* RoutineControl
  if (action === 'confirm') yield* control.confirmEvents(changed.id, changed.revision)
  if (action === 'archive') yield* control.archive(id)
  yield* control.reconcile
  return yield* (yield* Routines).view(id)
})
/** Keeps the Agent shell thin while the native scheduler and Pi own their respective lifecycle boundaries. */
export class RoutineController extends RoutineRunner {
  readonly #input: Input
  readonly #run: RunProgram
  #events: Promise<RoutineEventBindings> | undefined
  #scheduler: RoutineScheduler | undefined
  constructor(run: RunProgram, harness: PiHarness, start: StartRun, input: Input) {
    super(run, harness, start, input.schedules.wake)
    this.#input = input
    this.#run = run
  }
  #scheduled(): RoutineScheduler {
    const { storage, owner, schedules, key } = this.#input
    this.#scheduler ??= new RoutineScheduler(storage, owner, this, schedules, key)
    return this.#scheduler
  }
  #eventBindings(): Promise<RoutineEventBindings> {
    this.#events ??= this.#run(
      Events.useSync(
        (events) =>
          new RoutineEventBindings({
            storage: this.#input.storage,
            owner: this.#input.owner(),
            events,
            runner: this,
            key: this.#input.key,
            wake: this.#input.schedules.wake,
          }),
      ),
    ).catch((error: unknown) => {
      this.#events = undefined
      throw error
    })
    return this.#events
  }
  async confirmEvents(id: string, revision: number): Promise<void> {
    await (await this.#eventBindings()).confirm(id, revision)
  }
  async consumeEvent(context: EventContext): Promise<void> {
    await (await this.#eventBindings()).consume(context)
  }
  async reconcile(): Promise<void> {
    await this.#scheduled().reconcile()
    await (await this.#eventBindings()).reconcile()
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
