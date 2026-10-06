import { PiHarness } from 'agents/harness/pi'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Extension, Registry } from '@earendil-works/pi-durable'
import { askUserExtension } from './ask-user.ts'
import type { makePiModels } from './model.ts'
import { personaExtension } from './persona.ts'

export type PiModels = ReturnType<typeof makePiModels>

/**
 * One log line per failure Pi reports and carries on from (a hook that threw, a background task's failed step): the
 * message only, capped, never the request or its content.
 */
const onReport = (error: unknown) =>
  console.warn(
    JSON.stringify({
      level: 'warn',
      event: 'pi',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
    }),
  )

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
 */
export function makePiHarness(
  pi: PiModels,
  base: readonly Extension[],
  extra: readonly Extension[],
  apps: AppTools,
): PiHarness {
  const registry = createRegistry()
  const defaults = [personaExtension, askUserExtension, ...base]
  for (const extension of [...defaults, ...extra]) registry.install(extension)
  apps.attach(registry)
  const settings = {
    get extensions() {
      return [...defaults, ...apps.extensions()]
    },
  }
  return new PiHarness({
    harness: ({ storage, context }) => {
      apps.restore()
      return Harness.open(storage, { models: pi.models, registry, settings, onReport }, context)
    },
    defaults: { model: pi.model, thinkingLevel: 'low' },
  })
}
