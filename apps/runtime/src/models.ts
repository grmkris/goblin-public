import { type ModelChoice, type ModelOption, PayRoute } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { type AppError, InvalidInput } from './http/errors.ts'
import { appModelChoice } from './storage/schema.ts'

type Known = Omit<ModelOption, 'id' | 'contextWindow'>

/**
 * The context window Pi assumes for every offered model until a model's own is recorded here: it compacts the
 * conversation before this many tokens. The composer shows how full it is.
 */
const CONTEXT_WINDOW = 131_072

/**
 * What the picker says about the models LiteLLM serves to goblin. Grouped by the route the call takes, because
 * quotas are per route: when Google refuses, an Alibaba model still answers. Probed 2026-10-04: every model here
 * calls tools; `images` is whether it reads image input (the others drop images silently).
 */
const KNOWN: Readonly<Record<string, Known>> = {
  'gemini-3.8-flash': { label: 'Gemini 3.8 Flash', route: 'Google', note: 'Fast, sees images', images: true },
  'qwen3.8-flash': { label: 'Qwen 3.8 Flash', route: 'Alibaba Cloud', note: 'Fast, sees images', images: true },
  'qwen3.8-max': { label: 'Qwen 3.8 Max', route: 'Alibaba Cloud', note: 'Larger, sees images', images: true },
  // Probed 2026-10-12: it thinks until its output limit on hard prompts, whatever budget it is given.
  'glm-5.3': { label: 'GLM 5.3', route: 'Alibaba Cloud', note: 'Thinks at length, text only', images: false },
  'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', route: 'Alibaba Cloud', note: 'Larger, text only', images: false },
  // Probed 2026-10-12 on the Token Plan: calls tools.
  'deepseek-v4.1-flash': {
    label: 'DeepSeek V4.1 Flash',
    route: 'Alibaba Cloud',
    note: 'Fast, text only',
    images: false,
  },
}

/** Never empty: the default model is always offered, first. */
export type ModelOptions = readonly [ModelOption, ...ModelOption[]]

const optionOf = (id: string): ModelOption => {
  const known = KNOWN[id]
  return known === undefined
    ? { id, label: id, route: 'Other', note: '', images: false, contextWindow: CONTEXT_WINDOW }
    : { id, ...known, contextWindow: CONTEXT_WINDOW }
}

/**
 * The models this deployment offers: `MODELS` (comma-separated LiteLLM model names) with the default `MODEL_ID`
 * always first. An unknown name is offered under its own name, text only.
 */
export function modelOptions(models: string | undefined, defaultId: string): ModelOptions {
  const more = (models ?? '').split(',').map((id) => id.trim())
  const others = [...new Set(more)].filter((id) => id !== '' && id !== defaultId)
  return [optionOf(defaultId), ...others.map(optionOf)]
}

/**
 * A route for model calls paid per call from the owner's Goblin Wallet over MPP on Tempo (ADR 0047): its name, the Pi
 * provider its calls go through, the model it answers with in place of the one asked for (none: the same model), and
 * how the owner knows it. The owner's pay mode (`pay-mode.ts`) says when a call takes it.
 */
export type PaidRoute = {
  readonly name: PayRoute
  readonly provider: string
  readonly model?: string
  readonly label: string
}

const PAID: Readonly<Record<PayRoute, Omit<PaidRoute, 'name'>>> = {
  // goblin's own endpoint (`/v1/chat/completions`) behind an MPP charge: every offered model, paying the deployment's
  // recipient (http/paid-inference.ts).
  goblin: { provider: 'goblin-paid-goblin', label: 'goblin' },
  // Tempo's MPP proxy to OpenRouter: DeepSeek V4.1 Flash, priced up front per call from max_tokens and the prompt.
  tempo: { provider: 'goblin-paid-tempo', model: 'deepseek/deepseek-v4.1-flash', label: 'Tempo' },
}

const isPayRoute = Schema.is(PayRoute)

/** The paid routes `PAID_INFERENCE` (comma-separated: `goblin`, `tempo`) sells, in its order. */
export const paidRoutes = (value: string | undefined): readonly PaidRoute[] =>
  [...new Set((value ?? '').split(',').map((name) => name.trim()))].flatMap((name) =>
    isPayRoute(name) ? [{ name, ...PAID[name] }] : [],
  )

/** The model that names threads and writes main's memory: `GOBLIN_MEMORY_MODEL` when offered, else the default. */
export function memoryModelId(memoryModel: string | undefined, options: ModelOptions): string {
  return options.find((option) => option.id === memoryModel)?.id ?? options[0].id
}

/** The user's stored pick (one row), if any. */
export interface ChoiceLedger {
  get(): string | undefined
  set(modelId: string, now: number): void
}

export class ModelChoiceStore implements ChoiceLedger {
  readonly #db: DrizzleSqliteDODatabase
  constructor(db: DrizzleSqliteDODatabase) {
    this.#db = db
  }

  get(): string | undefined {
    return this.#db.select().from(appModelChoice).where(eq(appModelChoice.id, 1)).get()?.modelId
  }

  set(modelId: string, now: number): void {
    this.#db
      .insert(appModelChoice)
      .values({ id: 1, modelId, updatedAt: now })
      .onConflictDoUpdate({ target: appModelChoice.id, set: { modelId, updatedAt: now } })
      .run()
  }
}

/**
 * The model this user's agent answers with. A stored pick the deployment no longer offers falls back to the
 * default, so removing a model from `MODELS` never strands anyone.
 */
export class ModelPicker {
  readonly #ledger: ChoiceLedger
  readonly #options: ModelOptions
  constructor(ledger: ChoiceLedger, options: ModelOptions) {
    this.#ledger = ledger
    this.#options = options
  }

  current(): string {
    const chosen = this.#ledger.get()
    return chosen !== undefined && this.#options.some((option) => option.id === chosen) ? chosen : this.#options[0].id
  }

  choice(): ModelChoice {
    return { current: this.current(), default: this.#options[0].id, options: this.#options }
  }

  /** Fails with `InvalidInput` for a model this deployment does not offer. */
  choose(modelId: string, now: number): ModelChoice {
    if (!this.#options.some((option) => option.id === modelId)) throw new InvalidInput({ reason: 'model' })
    this.#ledger.set(modelId, now)
    return this.choice()
  }
}

/** The model the owner's agent answers with, and the owner's pick among those the deployment offers. */
export class Models extends Context.Service<
  Models,
  {
    /** The pick when the deployment still offers it, else the default. */
    readonly current: Effect.Effect<string>
    readonly choice: Effect.Effect<ModelChoice>
    /** Stores the pick (epoch seconds); `InvalidInput` for a model the deployment does not offer. */
    readonly choose: (modelId: string, now: number) => Effect.Effect<ModelChoice, AppError>
  }
>()('goblin/models/Models') {}
