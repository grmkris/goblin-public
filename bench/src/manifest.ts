import { Schema } from 'effect'
import { Manifest, type Variant } from './schema.ts'
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

export const decodeManifest = Schema.decodeUnknownSync(Manifest)

function variantErrors(manifest: Manifest): string[] {
  const ids = new Set<string>()
  const errors: string[] = []
  for (const variant of manifest.variants) {
    if (ids.has(variant.id)) errors.push(`duplicate variant ${variant.id}`)
    ids.add(variant.id)
    if (variant.policy === 'optchat' && variant.writer === undefined) errors.push(`${variant.id} needs a writer`)
    if (variant.policy !== 'optchat' && variant.writer !== undefined)
      errors.push(`${variant.id} native writer must remain coupled to reader`)
  }
  return errors
}

export function validateManifest(manifest: Manifest): string[] {
  const scenarios = dataset()
  const errors = variantErrors(manifest)
  if (manifest.variants.length === 0 || manifest.scenarioIds.length === 0) errors.push('empty experiment')
  if (new Set(manifest.scenarioIds).size !== manifest.scenarioIds.length) errors.push('duplicate scenarios')
  const { pressure } = manifest
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
