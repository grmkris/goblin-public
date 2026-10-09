import type { RoutineController } from './controller.ts'
import type { RoutineSlot } from './scheduler.ts'

/** The routines' alarm (`routinesWake`): one maintenance sweep; a failed one is tried again in a minute. */
export async function routinesWake(routines: RoutineController, wake: (at: number) => Promise<void>): Promise<void> {
  await routines.maintain().catch(() => wake(Date.now() + 60_000))
}

/** A routine's scheduled slot is due (`runRoutine`). */
export async function runRoutine(routines: RoutineController, slot: RoutineSlot): Promise<void> {
  await routines.fire(slot)
}

/** A routine run reached its deadline (`runRoutineDeadline`). */
export async function runRoutineDeadline(routines: RoutineController, input: { runId: string }): Promise<void> {
  await routines.deadline(input.runId)
}
