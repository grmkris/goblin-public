// What a model call costs in estimated Alibaba Token Plan Credits (ADR 0026): the unit the plan bills goblin's shared
// model key in, so the daily allowance spends the way the plan does.

/** One model response's tokens by kind, as pi-ai reports them: `input` excludes the cached tokens in `cacheRead`. */
export type TokenUse = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** How many tokens of each kind make one Credit for a model. */
export type CreditRate = { readonly input: number; readonly cached: number; readonly output: number }

/** Rates by model: one default, overrides per model id, and aliases that price one model as another. */
export type CreditRates = {
  readonly default: CreditRate
  readonly models: Readonly<Record<string, CreditRate>>
  readonly aliases: Readonly<Record<string, string>>
}

/**
 * Alibaba's own example for the Token Plan: about 5,000 fresh input tokens, 50,000 cached input tokens or 830 output
 * tokens per Credit. Gemini 3.8 Flash, which the plan does not list, is priced as Qwen 3.8 Flash.
 */
export const DEFAULT_RATES: CreditRates = {
  default: { input: 5000, cached: 50_000, output: 830 },
  models: {},
  aliases: { 'gemini-3.8-flash': 'qwen3.8-flash' },
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

const rateOf = (value: unknown): CreditRate | undefined =>
  isRecord(value) && positive(value.input) && positive(value.cached) && positive(value.output)
    ? { input: value.input, cached: value.cached, output: value.output }
    : undefined

/**
 * `GOBLIN_MODEL_CREDIT_RATES`: JSON `{ default?, models?: { id: rate }, aliases?: { id: id } }`, each rate
 * `{ input, cached, output }` in tokens per Credit. What is missing or invalid keeps {@link DEFAULT_RATES}.
 */
export function creditRates(value: string | undefined): CreditRates {
  if (value === undefined || value.trim() === '') return DEFAULT_RATES
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // expected: rates that are not JSON keep the defaults, as documented above.
    return DEFAULT_RATES
  }
  if (!isRecord(parsed)) return DEFAULT_RATES
  const models = isRecord(parsed.models)
    ? Object.fromEntries(
        Object.entries(parsed.models).flatMap(([id, rate]) => {
          const valid = rateOf(rate)
          return valid === undefined ? [] : [[id, valid] as const]
        }),
      )
    : {}
  const aliases = isRecord(parsed.aliases)
    ? Object.fromEntries(
        Object.entries(parsed.aliases).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
      )
    : {}
  return {
    default: rateOf(parsed.default) ?? DEFAULT_RATES.default,
    models,
    aliases: { ...DEFAULT_RATES.aliases, ...aliases },
  }
}

/** A model's rate: its own, its alias's, or the default. */
export function rateFor(model: string | undefined, rates: CreditRates): CreditRate {
  if (model === undefined) return rates.default
  const priced = rates.aliases[model] ?? model
  return rates.models[priced] ?? rates.default
}

/** A response's cost in thousandths of a Credit, rounded up (a cache write is priced as fresh input). */
export function milliCredits(use: TokenUse, model: string | undefined, rates: CreditRates): number {
  const rate = rateFor(model, rates)
  const credits = (use.input + use.cacheWrite) / rate.input + use.cacheRead / rate.cached + use.output / rate.output
  return Number.isFinite(credits) && credits > 0 ? Math.ceil(credits * 1000) : 0
}

/** Every token of a response, whatever its kind. */
export const totalTokens = (use: TokenUse): number => use.input + use.output + use.cacheRead + use.cacheWrite
