import { PiHarness } from 'agents/harness/pi'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import { askUserExtension } from './ask-user.ts'
import type { makePiModels } from './model.ts'
import { personaExtension } from './persona.ts'

export type PiModels = ReturnType<typeof makePiModels>

/**
 * Keep the beta Pi adapter in one small seam for a future Agents SDK upgrade. Every conversation selects the persona,
 * `ask_user` and `base`; `extra` is installed for the conversations that add it by name (a thread's own tools).
 */
export function makePiHarness(pi: PiModels, base: readonly Extension[], extra: readonly Extension[]): PiHarness {
  const registry = createRegistry()
  const defaults = [personaExtension, askUserExtension, ...base]
  for (const extension of [...defaults, ...extra]) registry.install(extension)
  return new PiHarness({
    harness: ({ storage, context }) =>
      Harness.open(storage, { models: pi.models, registry, settings: { extensions: defaults } }, context),
    defaults: { model: pi.model, thinkingLevel: 'low' },
  })
}
