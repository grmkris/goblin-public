import type { ModelChoice, ModelOption } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { InvalidInput } from './http/errors.ts'
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
  'glm-5.3': { label: 'GLM 5.3', route: 'Alibaba Cloud', note: 'Text only', images: false },
  'deepseek-v4-pro': { label: 'DeepSeek V4 Pro', route: 'Alibaba Cloud', note: 'Larger, text only', images: false },
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
