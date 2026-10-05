import { providerDetails } from './provider-details.ts'
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
    if (!this.accepts(reservation)) return false
    this.#totals = this.#next(reservation)
    return true
  }
  #next(reservation: Reservation): Totals {
    return {
      requests: this.#totals.requests + 1,
      input: this.#totals.input + reservation.input,
      output: this.#totals.output + reservation.output,
    }
  }
  accepts(reservation: Reservation): boolean {
    const next = this.#next(reservation)
    if (
      next.requests > this.#limits.maxRequests ||
      next.input > this.#limits.maxInputTokens ||
      next.output > this.#limits.maxOutputTokens
    )
      return false
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
  const usage = providerDetails(text).usage
  return usage === undefined ? undefined : { input: usage.prompt_tokens, output: usage.completion_tokens }
}
