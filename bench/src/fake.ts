import { Schema } from 'effect'

export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Unknown })),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
  max_tokens: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number),
  stream: Schema.optional(Schema.Boolean),
})
export type ChatRequest = typeof ChatRequest.Type

/** Keyless transport fixture: derives text solely from supplied provider context, never fixture facts. */
export function fakeContent(request: ChatRequest): string {
  const texts = request.messages.map(({ content }) => (typeof content === 'string' ? content : JSON.stringify(content)))
  const last = texts.at(-1) ?? ''
  if (texts.some((text) => text.includes('Return JSON only:'))) {
    const source = texts.join('\n')
    const match = /\[source:([a-zA-Z0-9_.:-]+)\] Replace the staging retry limit with (\d+)/u.exec(source)
    if (last.includes('retry limit') && match !== null)
      return JSON.stringify({
        claims: [{ key: 'staging-retries', value: match[2] }],
        evidenceIds: [match[1]],
        abstain: false,
      })
    return JSON.stringify({ claims: [], evidenceIds: [], abstain: true })
  }
  // Summaries deliberately lossy: plumbing validation must not masquerade as benchmark quality.
  const sources = texts.join('\n').match(/\[source:[a-zA-Z0-9_.:-]+\][^\n]*/gu) ?? []
  return sources.slice(-2).join('; ').slice(0, 300) || `Fixture summary: ${last.slice(-200)}`
}

export function fakeResponse(request: ChatRequest): Response {
  const content = fakeContent(request)
  const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
  if (!request.stream)
    return Response.json({
      id: 'fixture',
      object: 'chat.completion',
      model: request.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage,
    })
  const chunk = {
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 0,
    model: request.model,
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  }
  const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  })
}
