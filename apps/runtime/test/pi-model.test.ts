import type { Message } from '@earendil-works/pi-ai'
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript'
import { describe, expect, it } from 'vitest'
import { LITELLM_STREAMS, MAX_OUTPUT_TOKENS, makePiModels } from '../src/pi/model.ts'

const env = { MODEL_ID: 'qwen3.8-flash', MODEL_BASE_URL: 'https://no-model-calls.invalid/v1', MODEL_KEY: 'test' }

/** The chat completions request pi-ai would send for `messages`, captured before it leaves. */
async function requestFor(messages: Message[]): Promise<Record<string, unknown>> {
  const { model } = makePiModels(env)
  let request: Record<string, unknown> = {}
  const stream = LITELLM_STREAMS.streamSimple(model, normalizeContext({ systemPrompt: 'Be brief.', messages }), {
    apiKey: 'test',
    onPayload: (params) => {
      // SAFETY: openai-completions hands over the JSON object it is about to send.
      request = params as Record<string, unknown>
      throw new Error('captured')
    },
  })
  await stream.result()
  return request
}

const ask = (text: string): Message => ({ role: 'user', content: text, timestamp: 1 })

describe('the output limit (unit)', () => {
  it('lets every answer run to 32K tokens', async () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_768)
    expect(await requestFor([ask('hi')])).toMatchObject({ max_completion_tokens: MAX_OUTPUT_TOKENS })
  })

  it('leaves the answer only what the context window has left', async () => {
    const request = await requestFor([ask('word '.repeat(400_000))])
    expect(request.max_completion_tokens).toBeLessThan(MAX_OUTPUT_TOKENS)
  })
})
