import { dataset } from './fixtures.ts'
import { starterManifest, validateManifest } from './manifest.ts'
import type { Manifest, Probe, Scenario, Variant } from './schema.ts'

export type Episode = { readonly id: string; readonly probe: Probe; readonly variant: Variant }
export function episodes(manifest: Manifest, scenarios: readonly Scenario[] = dataset()): Episode[] {
  return scenarios
    .filter((scenario) => manifest.scenarioIds.includes(scenario.id))
    .flatMap((scenario) =>
      scenario.probes.flatMap((probe) =>
        manifest.variants.map((variant) => ({ id: `${probe.id}.${variant.id}`, probe, variant })),
      ),
    )
}

export function plan(manifest: Manifest = starterManifest(), scenarios: readonly Scenario[] = dataset()) {
  const cases = episodes(manifest, scenarios)
  const builds = new Set(
    cases.map(
      ({ probe, variant }) =>
        `${probe.scenarioId}.${probe.cutoff}.${variant.policy === 'optchat' ? 'optchat' : 'standard'}.${variant.writer ?? variant.reader}`,
    ),
  )
  return {
    manifest: manifest.name,
    errors: validateManifest(manifest, scenarios),
    scenarios: manifest.scenarioIds.length,
    probes: cases.length / manifest.variants.length,
    variants: manifest.variants.length,
    answers: cases.length,
    checkpoints: builds.size,
    minimumRequests: cases.length,
    estimates: 'Writer/retrieval/retry requests are additional; exact writer counts depend on generated summaries.',
    withinAnswerLimit: cases.length <= manifest.allowance.maxAnswers,
    limits: manifest.allowance,
  }
}
