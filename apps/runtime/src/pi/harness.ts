import { PiHarness } from 'agents/harness/pi'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Extension, Registry } from '@earendil-works/pi-durable'
import type { PiRunRecorder } from '../telemetry/pi.ts'
import { safeErrorType } from '../telemetry/safety.ts'
import { askUserExtension } from './ask-user.ts'
import { MAX_OUTPUT_TOKENS, type makePiModels } from './model.ts'
import { personaExtension } from './persona.ts'

export type PiModels = ReturnType<typeof makePiModels>

/**
 * One log line per failure Pi reports and carries on from (a hook that threw, a background task's failed step): what
 * failed and why, bounded, never the request or its content.
 */
const onReport = (error: unknown) =>
  console.warn(JSON.stringify({ level: 'warn', event: 'pi', error: safeErrorType(error) }))

/** The agent's apps as Pi sees them: extensions installed into its registry and selected by default (ADR 0021). */
export interface AppTools {
  attach(registry: Registry): void
  /** Installs every app's tools; runs before Pi opens, so a restarted agent offers them on its first request. */
  restore(): void
  extensions(): readonly Extension[]
}

/**
 * Keep the beta Pi adapter in one small seam for a future Agents SDK upgrade. Every conversation selects the persona,
 * `ask_user`, `base` and the apps' extensions; `extra` is installed for the conversations that add it by name (a
 * thread's own tools). The default selection is a getter, read at every use, so an app built or changed is offered
 * from the next model request. Subagents and routine runs set their own exact lists, so they get no app tools.
 * `recorder` follows Pi's commits from the moment it opens, before any of its work resumes (the run ledger, ADR 0024).
 */
export function makePiHarness(
  pi: PiModels,
  base: readonly Extension[],
  extra: readonly Extension[],
  apps: AppTools,
  recorder: Pick<PiRunRecorder, 'attach' | 'restore'>,
): PiHarness {
  const registry = createRegistry()
  const defaults = [personaExtension, askUserExtension, ...base]
  for (const extension of [...defaults, ...extra]) registry.install(extension)
  apps.attach(registry)
  const settings = {
    get extensions() {
      return [...defaults, ...apps.extensions()]
    },
    // pi-ai clamps each request's output limit to what the context leaves, less 4,096. Compacting once the context
    // leaves less than a full answer keeps every answer's limit at MAX_OUTPUT_TOKENS.
    compaction: { reserveTokens: MAX_OUTPUT_TOKENS + 4096 },
  }
  return new PiHarness({
    harness: async ({ storage, context }) => {
      apps.restore()
      const harness = await Harness.open(storage, { models: pi.models, registry, settings, onReport }, context)
      recorder.attach(harness)
      await recorder.restore(harness, context)
      return harness
    },
    defaults: { model: pi.model, thinkingLevel: 'low' },
  })
}
