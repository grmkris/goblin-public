import { PiHarness } from 'agents/harness/pi'
import { createRegistry, Harness } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import type { RuntimeEnv } from '../env.ts'
import { askUserExtension } from './ask-user.ts'
import { makePiModels } from './model.ts'
import { personaExtension } from './persona.ts'

/** Keep the beta Pi adapter in one small seam for a future Agents SDK upgrade. */
export function makePiHarness(env: RuntimeEnv, extensions: readonly Extension[] = []): PiHarness {
  const { models, model } = makePiModels(env)
  const registry = createRegistry()
  registry.install(personaExtension)
  registry.install(askUserExtension)
  for (const extension of extensions) registry.install(extension)
  return new PiHarness({
    harness: ({ storage, context }) => Harness.open(storage, { models, registry }, context),
    defaults: { model, thinkingLevel: 'low' },
  })
}
