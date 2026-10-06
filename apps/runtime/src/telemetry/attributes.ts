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

const MAX_ERROR = 300
const OWN_TEXT = new Set(['_tag', 'name', 'message', 'stack', 'cause'])

/** A tagged failure's scalar fields (`reason: timeout`), the part of it that says what went wrong. */
const fieldsOf = (error: object): string[] =>
  Object.entries(error).flatMap(([key, field]) =>
    !OWN_TEXT.has(key) && (Predicate.isString(field) || Predicate.isNumber(field) || Predicate.isBoolean(field))
      ? [`${key}: ${String(field).slice(0, 80)}`]
      : [],
  )

function describeOne(error: unknown): string {
  if (Predicate.isString(error)) return error
  if (!Predicate.isObject(error)) return String(error)
  const tag = '_tag' in error && Predicate.isString(error._tag) ? error._tag : undefined
  const name = tag ?? (error instanceof Error && error.name !== 'Error' ? error.name : undefined)
  const fields = tag === undefined ? [] : fieldsOf(error)
  const head = fields.length === 0 ? name : `${name ?? 'error'} (${fields.join(', ')})`
  const message = 'message' in error && Predicate.isString(error.message) ? error.message : ''
  return [head, message].filter((part) => part !== undefined && part !== '').join(': ') || 'error without a message'
}

/**
 * Any failure as one bounded line, for logs and the `goblin.error` attribute: its tag or name, a tagged failure's
 * scalar fields, its message, then its causes. Never `[object Object]`. Remote error text stays data (ADR 0024).
 */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let current = error
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    parts.push(describeOne(current))
    current = Predicate.isObject(current) && 'cause' in current ? current.cause : undefined
  }
  return parts.join(', caused by ').slice(0, MAX_ERROR)
}

/** `ok`, or a failure's tag with its reason (`UpstreamMcp:timeout`); `error` for anything untagged. */
export const outcomeOf = (error: unknown): string => {
  if (!Predicate.isObject(error) || !('_tag' in error) || !Predicate.isString(error._tag)) return 'error'
  return 'reason' in error && Predicate.isString(error.reason) ? `${error._tag}:${error.reason}` : error._tag
}

/** A failure as attributes: its tag as `error.type` and its bounded message. */
export const failureAttributes = (error: unknown): RunAttributes => ({
  [RunAttribute.errorType]: outcomeOf(error),
  [RunAttribute.error]: describeError(error),
})
