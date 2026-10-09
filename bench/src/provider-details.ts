import { Option, Schema } from 'effect'

const Tokens = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Usage = Schema.Struct({
  prompt_tokens: Tokens,
  completion_tokens: Tokens,
  prompt_tokens_details: Schema.optional(
    Schema.Struct({ cached_tokens: Schema.optional(Tokens), cache_creation_tokens: Schema.optional(Tokens) }),
  ),
  completion_tokens_details: Schema.optional(Schema.Struct({ reasoning_tokens: Schema.optional(Tokens) })),
})
const Envelope = Schema.Struct({
  model: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.NullOr(Usage)),
})

/** Buffered SSE provides total response latency, not TTFT. Completion tokens already include reasoning tokens. */
export function providerDetails(text: string) {
  const candidates = text.split('\n').some((line) => line.startsWith('data:'))
    ? text
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .filter((line) => line !== '[DONE]')
    : [text]
  let responseModel: string | undefined
  let responseId: string | undefined
  let usage: typeof Usage.Type | undefined
  for (const candidate of candidates) {
    try {
      const decoded = Schema.decodeUnknownOption(Envelope)(JSON.parse(candidate))
      if (Option.isNone(decoded)) continue
      responseModel = decoded.value.model ?? responseModel
      responseId = decoded.value.id ?? responseId
      usage = decoded.value.usage ?? usage
    } catch {
      // expected: a non-JSON provider failure has no measurable token usage
    }
  }
  return {
    responseModel,
    responseId,
    usage,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cacheReadTokens: usage?.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens: usage?.prompt_tokens_details?.cache_creation_tokens,
  }
}
