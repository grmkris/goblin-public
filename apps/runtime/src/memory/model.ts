import type { Models } from '@earendil-works/pi-ai'
import * as Schema from 'effect/Schema'
import type { TokenUse } from '../budget-credits.ts'
import { nowMillis } from '../clock.ts'
import { MODEL_PROVIDER } from '../pi/model.ts'
import type { AuxCall } from '../telemetry/report.ts'

/** Room for the thinking a model does before answering by default: it counts against `maxTokens`. */
const THINKING_HEADROOM = 2048

/**
 * The cheap model gave no answer: `model` is not one of the offered models, or its call ended in an error or was cut
 * short. `detail` is the provider's own error text, kept only for `modelFailureText`; the reporter never logs a field.
 */
export class ModelFailed extends Schema.TaggedError<ModelFailed>()('ModelFailed', {
  model: Schema.String,
  reason: Schema.Literals(['not_offered', 'error', 'aborted']),
  detail: Schema.optional(Schema.String),
}) {}

/** A model failure as its text read before it was tagged: what an agent app's `llm()` shows (agent-apps/ports.ts). */
export const modelFailureText = (failure: ModelFailed): string =>
  failure.reason === 'not_offered'
    ? `Memory model ${failure.model} is not offered`
    : (failure.detail ?? `Memory model ${failure.reason}`)

/** Narrow completion seam shared by resident memory and isolated benchmark writers. */
export interface TextCompletion {
  complete(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string>
}

/**
 * The deployment's cheap model for housekeeping nobody asked the agent for: naming threads, summarizing main into its
 * memory. It is one of the offered models (`GOBLIN_MEMORY_MODEL`), called on the same LiteLLM key, and every token
 * it spends counts toward the user's daily budget through `spent`.
 */
export class CheapModel {
  readonly #models: Models
  readonly #id: string
  readonly #spent: (use: TokenUse) => void
  readonly #report: (call: AuxCall) => void

  /** `report` hears every call's response or error (the run ledger, ADR 0024). */
  constructor(models: Models, id: string, spent: (use: TokenUse) => void, report: (call: AuxCall) => void = () => {}) {
    this.#models = models
    this.#id = id
    this.#spent = spent
    this.#report = report
  }

  /** One completion without tools, its answer at most `maxTokens`; its text, or `ModelFailed` when the model failed. */
  async complete(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    const model = this.#models.getModel(MODEL_PROVIDER, this.#id)
    if (model === undefined) throw new ModelFailed({ model: this.#id, reason: 'not_offered' })
    const startedAt = nowMillis()
    const message = await this.#models
      .completeSimple(
        model,
        { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: startedAt }] },
        { maxTokens: maxTokens + THINKING_HEADROOM, ...(signal === undefined ? {} : { signal }) },
      )
      .catch((error: unknown) => {
        this.#report({ startedAt, error })
        throw error
      })
    this.#report({ startedAt, message })
    this.#spent(message.usage)
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      throw new ModelFailed({
        model: this.#id,
        reason: message.stopReason,
        ...(message.errorMessage === undefined ? {} : { detail: message.errorMessage }),
      })
    return message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim()
  }
}
