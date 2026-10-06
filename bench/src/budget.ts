import { providerDetails } from './provider-details.ts'
import type { Manifest } from './schema.ts'
import type { Trace } from './results.ts'

export type Reservation = { readonly input: number; readonly output: number }
export type Totals = { readonly requests: number; readonly input: number; readonly output: number }
export type AllowanceLimits = Pick<Manifest['allowance'], 'maxRequests' | 'maxInputTokens' | 'maxOutputTokens'>

/** Every upstream attempt reserves before it starts. Missing usage keeps the full reservation charged. */
export class Budget {
  #totals: Totals
  readonly #limits: AllowanceLimits
  constructor(limits: AllowanceLimits, totals: Totals = { requests: 0, input: 0, output: 0 }) {
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

export function phaseLimits(manifest: Manifest, phase: 'preflight' | 'build' | 'answer' | 'judge'): AllowanceLimits {
  return manifest.allowance.phases?.[phase] ?? manifest.allowance
}

export function minimumLimits(a: AllowanceLimits, b: AllowanceLimits): AllowanceLimits {
  return {
    maxRequests: Math.min(a.maxRequests, b.maxRequests),
    maxInputTokens: Math.min(a.maxInputTokens, b.maxInputTokens),
    maxOutputTokens: Math.min(a.maxOutputTokens, b.maxOutputTokens),
  }
}

export const transientStatus = (status: number): boolean => [429, 502, 503, 504].includes(status)

/** A requested output cap is insufficient evidence when the provider bills additional reasoning outside it. */
export function exceededReservation(trace: Trace): boolean {
  return (
    !trace.unknownUsage &&
    (trace.input > (trace.reservedInput ?? trace.input) || trace.output > (trace.reservedOutput ?? trace.output))
  )
}

export function usageOf(text: string): Reservation | undefined {
  const usage = providerDetails(text).usage
  return usage === undefined ? undefined : { input: usage.prompt_tokens, output: usage.completion_tokens }
}
