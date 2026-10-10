import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import type { RoutineSchedules, RoutineSlot } from './scheduler.ts'
import { RoutineControl } from './service.ts'

// The routines' alarms, as the agent's schedule callbacks run them: each is one `RoutineControl` program through the
// bridge's `local` (no plan check; admission checks the plan where it matters).

/** The routines' alarm (`routinesWake`): one maintenance sweep; a failed one is logged and tried again in a minute. */
export async function routinesWake(local: RunProgram, wake: (at: number) => Promise<void>): Promise<void> {
  await local(RoutineControl.use((control) => control.maintain)).catch((error: unknown) => {
    writeLine('warn', { event: 'wake', task: 'routines.maintain', 'error.type': safeErrorType(error) })
    return wake(Date.now() + 60_000)
  })
}

/** A routine's scheduled slot is due (`runRoutine`). */
export async function runRoutine(local: RunProgram, slot: RoutineSlot): Promise<void> {
  await local(RoutineControl.use((control) => control.fire(slot)))
}

/** A routine run reached its deadline (`runRoutineDeadline`). */
export async function runRoutineDeadline(local: RunProgram, input: { runId: string }): Promise<void> {
  await local(RoutineControl.use((control) => control.deadline(input.runId)))
}

/** The agent's native schedules as the routines use them: dated alarms on whole seconds, made idempotent by agent.ts. */
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
