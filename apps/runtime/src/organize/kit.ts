import type { StopRuntime } from '../agent-program.ts'
import { organizeExtension } from '../pi/organize.ts'
import { type PersonaTurnKit, personaTurnExtension } from '../pi/persona-turn.ts'
import type { RunProgram } from '../pi/resident-mcp.ts'

export type { PersonaTurnKit }

/**
 * What the Agent adds for Personas and organizing (ADR 0033): the Persona turn kit (its extension is selected by a
 * Persona's fork alone) and the organize tools every Conversation and thread has. `stopping` is read when a tool
 * archives a Topic, not at definition.
 */
export function organizingKit(run: RunProgram, stopping: () => StopRuntime) {
  return { personas: personaTurnExtension(run), organize: organizeExtension(run, stopping) }
}
