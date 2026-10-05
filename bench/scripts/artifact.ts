import { createHash } from 'node:crypto'
import { dataset } from '../src/fixtures.ts'
import { publicEvents } from '../src/protocol.ts'
import type { Resolved } from '../src/results.ts'
import { buildPolicy, type Scenario, type Variant } from '../src/schema.ts'

export const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Review seals ignore object property order; artifact identity keeps its historical encoding. */
export function fingerprint(value: unknown): string {
  return digest(canonical(value))
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}
export const corpusHash = (scenarios: readonly Scenario[] = dataset()): string => digest(scenarios)
/** Reader-independent OptChat builds, coupled native writers, and shared search/standard compaction roots. */
export function artifactIdentity(resolved: Resolved, scenarioId: string, variant: Variant): string {
  const scenario = (resolved.scenarios ?? dataset()).find((item) => item.id === scenarioId)
  return digest({
    source: resolved.sourceHash,
    corpus: scenario === undefined ? '' : publicEvents(scenario.events),
    mode: resolved.mode,
    policy: buildPolicy(variant.policy),
    writer: variant.writer ?? variant.reader,
    profile: resolved.manifest.profile,
    pressure: resolved.manifest.pressure,
    transport: resolved.manifest.transport,
    trial: resolved.manifest.buildTrial,
    prompt: resolved.manifest.summaryPrompt,
  })
}
