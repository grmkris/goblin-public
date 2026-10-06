import type { Models } from '@earendil-works/pi-ai'
import { MODEL_PROVIDER } from '../pi/model.ts'

/** Room for the thinking a model does before answering by default: it counts against `maxTokens`. */
const THINKING_HEADROOM = 2048

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
  readonly #spent: (tokens: number) => void

  constructor(models: Models, id: string, spent: (tokens: number) => void) {
    this.#models = models
    this.#id = id
    this.#spent = spent
  }

  /** One completion without tools, its answer at most `maxTokens`; its text, or a throw when the model failed. */
  async complete(system: string, user: string, maxTokens: number, signal?: AbortSignal): Promise<string> {
    const model = this.#models.getModel(MODEL_PROVIDER, this.#id)
    if (model === undefined) throw new Error(`Memory model ${this.#id} is not offered`)
    const message = await this.#models.completeSimple(
      model,
      { systemPrompt: system, messages: [{ role: 'user', content: user, timestamp: Date.now() }] },
      { maxTokens: maxTokens + THINKING_HEADROOM, ...(signal === undefined ? {} : { signal }) },
    )
    this.#spent(message.usage.totalTokens)
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      throw new Error(message.errorMessage ?? `Memory model ${message.stopReason}`)
    return message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim()
  }
}
