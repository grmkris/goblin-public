import { writeLine } from '../observability/logger.ts'
import { safeErrorType } from '../observability/report.ts'
import type { RoutineController } from './controller.ts'
import type { RoutineSlot } from './scheduler.ts'

/** The routines' alarm (`routinesWake`): one maintenance sweep; a failed one is logged and tried again in a minute. */
export async function routinesWake(routines: RoutineController, wake: (at: number) => Promise<void>): Promise<void> {
  await routines.maintain().catch((error: unknown) => {
    writeLine('warn', { event: 'wake', task: 'routines.maintain', 'error.type': safeErrorType(error) })
    return wake(Date.now() + 60_000)
  })
}

/** A routine's scheduled slot is due (`runRoutine`). */
export async function runRoutine(routines: RoutineController, slot: RoutineSlot): Promise<void> {
  await routines.fire(slot)
}

/** A routine run reached its deadline (`runRoutineDeadline`). */
export async function runRoutineDeadline(routines: RoutineController, input: { runId: string }): Promise<void> {
  await routines.deadline(input.runId)
}
