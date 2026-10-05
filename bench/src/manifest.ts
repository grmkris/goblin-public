import { Schema } from 'effect'
import { Manifest, type Scenario, type Variant } from './schema.ts'
import { dataset, validateScenario } from './fixtures.ts'

const MODELS = ['glm-5.3', 'deepseek-v4-pro-0813']
export function starterManifest(): Manifest {
  const optchat: Variant[] = MODELS.flatMap((writer) =>
    MODELS.map((reader) => ({
      id: `optchat.${writer}.${reader}`,
      policy: 'optchat',
      writer,
      reader,
    })),
  )
  const controls: Variant[] = MODELS.flatMap((reader) => [
    { id: `standard.${reader}`, policy: 'standard', reader },
    { id: `search.${reader}`, policy: 'standard-search', reader },
  ])
  return {
    schemaVersion: 1,
    name: 'starter',
    split: 'development',
    profile: 'controlled',
    scenarioIds: ['staging', 'interface', 'recovery'],
    variants: [...optchat, ...controls],
    pressure: { contextWindowTokens: 8192, reserveTokens: 2048, keepRecentTokens: 1024, viewBytes: 4096 },
    allowance: {
      maxAnswers: 200,
      maxRequests: 1000,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 100_000,
      concurrency: 2,
    },
    retrieval: { maxCalls: 4, maxBytes: 4096 },
    buildTrial: 0,
    summaryPrompt: null,
    recallGuide: null,
    rates: [],
  }
}

/** Real canaries keep each writer coupled to its reader and retain provider-compatible thinking defaults. */
export function canaryManifest(
  id: string,
  scenarioId: string,
  corpus: NonNullable<Manifest['corpus']>,
): Manifest & { readonly corpus: NonNullable<Manifest['corpus']> } {
  const starter = starterManifest()
  return {
    ...starter,
    name: `real-${id}`,
    scenarioIds: [scenarioId],
    transport: { contextWindowTokens: 131_072, thinking: 'provider-default' },
    corpus,
    variants: starter.variants.filter((variant) => variant.policy !== 'optchat' || variant.writer === variant.reader),
    allowance: { ...starter.allowance, maxAnswers: 36, concurrency: 1 },
  }
}

export const decodeManifest = Schema.decodeUnknownSync(Manifest)

function variantErrors(manifest: Manifest): string[] {
  const ids = new Set<string>()
  const errors: string[] = []
  for (const variant of manifest.variants) {
    if (ids.has(variant.id)) errors.push(`duplicate variant ${variant.id}`)
    ids.add(variant.id)
    if (!MODELS.includes(variant.reader) || (variant.writer !== undefined && !MODELS.includes(variant.writer)))
      errors.push(`${variant.id} selects an unconfigured model ID`)
    if (variant.policy === 'optchat' && variant.writer === undefined) errors.push(`${variant.id} needs a writer`)
    if (variant.policy !== 'optchat' && variant.writer !== undefined)
      errors.push(`${variant.id} native writer must remain coupled to reader`)
  }
  return errors
}

function allowanceErrors(manifest: Manifest, scenarios: readonly Scenario[]): string[] {
  const errors: string[] = []
  const { allowance } = manifest
  if (
    allowance.maxAnswers > 200 ||
    allowance.maxRequests > 1000 ||
    allowance.maxInputTokens > 1_000_000 ||
    allowance.maxOutputTokens > 100_000
  )
    errors.push('allowance exceeds global ceilings')
  if (
    scenarios
      .filter((scenario) => manifest.scenarioIds.includes(scenario.id))
      .reduce((n, scenario) => n + scenario.probes.length, 0) *
      manifest.variants.length >
    allowance.maxAnswers
  )
    errors.push('answer plan exceeds allowance')
  if (manifest.retrieval.maxCalls > 4 || manifest.retrieval.maxBytes > 4096)
    errors.push('retrieval exceeds shared ceiling')
  if (
    manifest.rates.some(
      (rate) => rate.inputPerMillion < 0 || rate.outputPerMillion < 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(rate.dated),
    )
  )
    errors.push('prices require nonnegative rates and YYYY-MM-DD provenance')
  return errors
}

export function validateManifest(manifest: Manifest, scenarios: readonly Scenario[] = dataset()): string[] {
  const errors = variantErrors(manifest)
  if (manifest.variants.length === 0 || manifest.scenarioIds.length === 0) errors.push('empty experiment')
  if (new Set(manifest.scenarioIds).size !== manifest.scenarioIds.length) errors.push('duplicate scenarios')
  const { pressure } = manifest
  errors.push(...allowanceErrors(manifest, scenarios))
  if (pressure.reserveTokens + pressure.keepRecentTokens >= pressure.contextWindowTokens)
    errors.push('invalid compaction pressure')
  for (const id of manifest.scenarioIds) {
    const scenario = scenarios.find((item) => item.id === id)
    if (scenario === undefined) errors.push(`unknown scenario ${id}`)
    else if (scenario.split !== manifest.split) errors.push(`split mismatch ${id}`)
    else errors.push(...validateScenario(scenario))
  }
  return errors
}
