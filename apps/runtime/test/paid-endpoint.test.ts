import { describe, expect, it } from 'vitest'
import type { RuntimeEnv } from '../src/env.ts'
import { dollarsOf, paidCompletion, priceUnits } from '../src/http/paid-inference.ts'

const RECIPIENT = '0x6649868b1B87711e405aa6690E3f0245d9510631'
/** A stage that sells `paid:goblin`: its recipient, a challenge secret and its own models. */
const env = (overrides: Partial<RuntimeEnv> = {}): RuntimeEnv =>
  // SAFETY: the paid endpoint reads only these fields of the Worker's environment.
  ({
    APP_URL: 'https://dev.goblin.surf',
    MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
    MODEL_KEY: 'test',
    MODEL_ID: 'deepseek-v4.1-flash',
    MODELS: 'qwen3.8-flash',
    PAID_INFERENCE: 'tempo,goblin',
    MPP_RECIPIENT: RECIPIENT,
    MPP_SECRET: 'a-test-secret-of-at-least-thirty-two-chars',
    ...overrides,
  }) as RuntimeEnv

const completion = (body: unknown) =>
  new Request('https://dev.goblin.surf/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** The `request` parameter of the first `Payment` challenge, decoded. */
const chargeOf = (header: string): Record<string, unknown> => {
  const encoded = /request="([^"]+)"/u.exec(header)?.[1] ?? ''
  // SAFETY: an MPP challenge's request parameter is base64url JSON of an object.
  return JSON.parse(atob(encoded.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>
}

describe("goblin's own paid model endpoint (ADR 0047)", () => {
  it("prices a call up front from its tokens, as Tempo's proxy does, never under the floor", () => {
    expect(priceUnits({ max_tokens: 1, messages: [] })).toBe(750)
    expect(priceUnits({ max_tokens: 10_000, messages: [] })).toBe(6001)
    expect(priceUnits({ messages: [] })).toBe(Math.ceil(0.6 * 32_768 + 0.1))
    expect(priceUnits({ max_completion_tokens: 99_999, messages: [] })).toBe(priceUnits({ messages: [] }))
    expect(dollarsOf(750)).toBe('0.000750')
  })

  it('stays a 404 where the stage does not sell it, or lacks a recipient or a secret', async () => {
    const request = completion({ model: 'deepseek-v4.1-flash', messages: [] })
    expect(await paidCompletion(request, env({ PAID_INFERENCE: 'tempo' }))).toBeUndefined()
    expect(await paidCompletion(request, env({ MPP_RECIPIENT: 'nope' }))).toBeUndefined()
    expect(await paidCompletion(request, env({ MPP_SECRET: 'short' }))).toBeUndefined()
  })

  it('answers an unpaid call with a Tempo charge in USDC.e to the recipient, and refuses what it does not sell', async () => {
    const answer = await paidCompletion(
      completion({ model: 'deepseek-v4.1-flash', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      env(),
    )
    expect(answer?.status).toBe(402)
    const header = answer?.headers.get('www-authenticate') ?? ''
    expect(header).toMatch(/method="tempo"/u)
    expect(header).toMatch(/intent="charge"/u)
    expect(chargeOf(header)).toMatchObject({ amount: '750', recipient: RECIPIENT })
    expect(String(chargeOf(header)['currency']).toLowerCase()).toBe('0x20c000000000000000000000b9537d11c60e8b50')
    expect((await paidCompletion(completion({ model: 'gpt-9', messages: [] }), env()))?.status).toBe(400)
    expect((await paidCompletion(new Request('https://dev.goblin.surf/v1/chat/completions'), env()))?.status).toBe(405)
  })
})
