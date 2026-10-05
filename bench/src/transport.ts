import type { Manifest } from './schema.ts'

/** Alibaba's OpenAI-compatible routes need an explicit thinking switch; Pi thinkingLevel=off sends no switch. */
export function requestPayload(original: Readonly<Record<string, unknown>>, thinking: 'provider-default' | 'disabled') {
  return JSON.stringify({
    ...original,
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
  JSON.stringify(left.transport) === JSON.stringify(right.transport)
