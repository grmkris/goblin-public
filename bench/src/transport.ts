import type { Manifest } from './schema.ts'

/** Per-route settings preserve the global fallback for all existing manifests. */
export function modelTransport(manifest: Manifest, model: string) {
  return manifest.modelTransport?.find((item) => item.model === model) ?? manifest.transport
}

/** Explicit disabling is opt-in: some routes (including GLM) require provider-default thinking. */
export function requestPayload(original: Readonly<Record<string, unknown>>, thinking: 'provider-default' | 'disabled') {
  return JSON.stringify({
    ...original,
    ...(Array.isArray(original['tools']) && original['tools'].length > 0 ? { tool_choice: 'auto' } : {}),
    ...(original['stream'] === true ? { stream_options: { include_usage: true } } : {}),
    ...(thinking === 'disabled' ? { enable_thinking: false, thinking: { type: 'disabled' } } : {}),
  })
}

/** Pressure controls native Pi scheduling. It must not become a false upstream capacity declaration. */
export function transportModel<T extends { readonly id: string; readonly contextWindow: number }>(
  model: T,
  windows: ReadonlyMap<string, number>,
): T {
  return { ...model, contextWindow: windows.get(model.id) ?? model.contextWindow }
}
export const sameTransport = (left: Manifest, right: Manifest): boolean =>
  JSON.stringify([left.transport, left.modelTransport]) === JSON.stringify([right.transport, right.modelTransport])
