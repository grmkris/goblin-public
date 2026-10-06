import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import { Predicate } from 'effect'

/** The parts of a model response telemetry reads; pi-ai's `AssistantMessage` has them. */
export type Answer = {
  readonly provider: string
  readonly model: string
  readonly responseModel?: string | undefined
  readonly responseId?: string | undefined
  readonly stopReason: string
  readonly errorMessage?: string | undefined
  readonly usage: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly reasoning?: number | undefined
  }
}

/** What a response tells about its model call: model, finish reason, tokens, error. Never its content. */
export function answerAttributes(message: Answer): RunAttributes {
  const { usage } = message
  return {
    [RunAttribute.provider]: message.provider,
    [RunAttribute.requestModel]: message.model,
    ...(message.responseModel === undefined ? {} : { [RunAttribute.responseModel]: message.responseModel }),
    ...(message.responseId === undefined ? {} : { [RunAttribute.responseId]: message.responseId }),
    [RunAttribute.finishReason]: message.stopReason,
    [RunAttribute.inputTokens]: usage.input,
    [RunAttribute.outputTokens]: usage.output,
    [RunAttribute.cacheReadTokens]: usage.cacheRead,
    [RunAttribute.cacheWriteTokens]: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { [RunAttribute.reasoningTokens]: usage.reasoning }),
    ...(message.errorMessage === undefined ? {} : { [RunAttribute.error]: message.errorMessage }),
  }
}

/** Stop reasons that are not a failure of the call. */
export const statusOfStop = (stop: string): 'ok' | 'error' | 'interrupted' => {
  if (stop === 'error') return 'error'
  return stop === 'aborted' ? 'interrupted' : 'ok'
}

/** An error's message, for the bounded `goblin.error` attribute. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** `ok`, or a failure's tag with its reason (`UpstreamMcp:timeout`); `error` for anything untagged. */
export const outcomeOf = (error: unknown): string => {
  if (!Predicate.isObject(error) || !('_tag' in error) || !Predicate.isString(error._tag)) return 'error'
  return 'reason' in error && Predicate.isString(error.reason) ? `${error._tag}:${error.reason}` : error._tag
}

/** A failure as attributes: its tag as `error.type` and its bounded message. */
export const failureAttributes = (error: unknown): RunAttributes => ({
  [RunAttribute.errorType]: outcomeOf(error),
  [RunAttribute.error]: messageOf(error),
})
