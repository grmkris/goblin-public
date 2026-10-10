import { organizeExtension } from '../pi/organize.ts'
import { type PersonaTurnKit, personaTurnExtension } from '../pi/persona-turn.ts'
import type { RunProgram } from '../runtime/bridge.ts'

export type { PersonaTurnKit }

/**
 * What the Agent adds for Personas and organizing (ADR 0033): the Persona turn kit (its extension is selected by a
 * Persona's fork alone) and the organize tools every Conversation and thread has.
 */
export function organizingKit(run: RunProgram) {
  return { personas: personaTurnExtension(run), organize: organizeExtension(run) }
}
