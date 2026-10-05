import type { Manifest } from './schema.ts'

export type Reservation = { readonly input: number; readonly output: number }
export type Totals = { readonly requests: number; readonly input: number; readonly output: number }

/** Every upstream attempt reserves before it starts. Missing usage keeps the full reservation charged. */
export class Budget {
  #totals: Totals
  readonly #limits: Manifest['allowance']
  constructor(limits: Manifest['allowance'], totals: Totals = { requests: 0, input: 0, output: 0 }) {
    this.#limits = limits
    this.#totals = totals
  }
  totals(): Totals {
    return { ...this.#totals }
  }
  reserve(reservation: Reservation): boolean {
    const next = {
      requests: this.#totals.requests + 1,
      input: this.#totals.input + reservation.input,
      output: this.#totals.output + reservation.output,
    }
    if (
      next.requests > this.#limits.maxRequests ||
      next.input > this.#limits.maxInputTokens ||
      next.output > this.#limits.maxOutputTokens
    )
      return false
    this.#totals = next
    return true
  }
  reconcile(reserved: Reservation, actual: Reservation | undefined): void {
    if (actual === undefined) return
    this.#totals = {
      ...this.#totals,
      input: this.#totals.input - reserved.input + actual.input,
      output: this.#totals.output - reserved.output + actual.output,
    }
  }
}

export const transientStatus = (status: number): boolean => [429, 502, 503, 504].includes(status)

export function usageOf(text: string): Reservation | undefined {
  const candidates = text.startsWith('data:')
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== '[DONE]')
    : [text]
  for (const candidate of candidates.toReversed()) {
    const usage = parseUsage(candidate)
    if (usage !== undefined) return usage
  }
  return undefined
}
function parseUsage(candidate: string): Reservation | undefined {
  try {
    const raw: unknown = JSON.parse(candidate)
    if (typeof raw !== 'object' || raw === null || !('usage' in raw)) return undefined
    const usage = raw.usage
    if (typeof usage !== 'object' || usage === null || !('prompt_tokens' in usage) || !('completion_tokens' in usage))
      return undefined
    if (
      typeof usage.prompt_tokens === 'number' &&
      typeof usage.completion_tokens === 'number' &&
      usage.prompt_tokens >= 0 &&
      usage.completion_tokens >= 0
    )
      return { input: usage.prompt_tokens, output: usage.completion_tokens }
  } catch {
    return undefined
  }
  return undefined
}
