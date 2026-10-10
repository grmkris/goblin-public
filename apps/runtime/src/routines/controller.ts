import type { PiHarness } from 'agents/harness/pi'
import type { RunProgram } from '../runtime/bridge.ts'
import { RoutineRunner, type StartRun } from './runner.ts'
import { RoutineScheduler, type RoutineSchedules, type RoutineSlot } from './scheduler.ts'
import type { RoutineRun } from './runs.ts'
import type { EventContext } from '../mcp/events/dispatcher.ts'
import { Events } from '../mcp/service.ts'
import { RoutineEventBindings } from './events.ts'

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
            run: this.#run,
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
