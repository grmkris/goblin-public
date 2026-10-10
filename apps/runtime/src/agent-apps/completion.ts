import * as Effect from 'effect/Effect'
import type { TokenUse } from '../budget-credits.ts'
import { Budget } from '../budget.ts'
import { epochSeconds } from '../clock.ts'
import { CheapModel, ModelFailed, modelFailureText } from '../memory/model.ts'
import { memoryModelId, modelOptions } from '../models.ts'
import { AgentInput } from '../runtime/input.ts'
import { auxReporter } from '../telemetry/report.ts'
import type { AppCompletion } from './ports.ts'
import { AppCodeError, promised } from './queue.ts'

/** An app reads a cheap-model failure as the text it always read: an AppCodeError's problemText is its message. */
export const appAnswer = (answer: Promise<string>): Promise<string> =>
  answer.catch((error: unknown) => {
    throw error instanceof ModelFailed ? new AppCodeError(modelFailureText(error)) : error
  })

/** The cheap model's completion for apps (`app_llm`): its tokens are recorded even when its answer fails. */
export const appCompletion: AppCompletion = (system, prompt, maxTokens) =>
  Effect.gen(function* () {
    const { env, pi, telemetry } = yield* AgentInput
    const budget = yield* Budget
    const id = memoryModelId(env.MEMORY_MODEL, modelOptions(env.MODELS, env.MODEL_ID))
    const spent: TokenUse[] = []
    const model = new CheapModel(pi.models, id, (use) => void spent.push(use), auxReporter(telemetry, 'app_llm'))
    const record = Effect.suspend(() =>
      Effect.forEach(spent, (use) => Effect.flatMap(epochSeconds, (now) => budget.record(use, now, id))),
    )
    return yield* promised(() => appAnswer(model.complete(system, prompt, maxTokens))).pipe(Effect.ensuring(record))
  })
