import { describe, expect, it } from 'vitest'
import type { RuntimeEnv } from '../../src/env.ts'
import { worker } from '../../src/http/worker.ts'
import { fake } from '../fake.ts'

const APP = 'https://goblin.test'

/** The deployment with an agent namespace that records every agent asked for, and never answers. */
const deployment = () => {
  const asked: string[] = []
  const agents = fake<RuntimeEnv['AGENTS']>({
    getByName: (name: string) => {
      asked.push(name)
      throw new Error('no agent in this test')
    },
  })
  // The routes under test read only the app's URL (and a hook's key) before they would ask for an agent.
  const env = fake<RuntimeEnv>({ APP_URL: APP, AGENTS: agents })
  return { env, asked }
}

describe('the Worker', () => {
  // The internal API is the agent's own, called on its stub by the Worker; no request from outside reaches it.
  it.each([
    '/internal/recent',
    '/internal/ask',
    '/internal/inspect',
    '/api/../internal/recent',
    '/api/%2e%2e/internal/recent',
    '/api/%2E%2E/internal/recent',
  ])('answers %s from outside with the 404 envelope, without waking an agent', async (path) => {
    const { env, asked } = deployment()
    const request = new Request(`${APP}${path}`, { method: 'POST', headers: { 'cf-ray': 'ray-internal' } })
    const response = await worker.fetch(request, env, { waitUntil: () => undefined })
    expect(response.status).toBe(404)
    expect(response.headers.get('x-goblin-ref')).toBe('ray-internal')
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'That does not exist.', what: 'route', ref: 'ray-internal' },
    })
    expect(asked).toEqual([])
  })

  it('answers a hook whose token does not verify with the 404 envelope, without waking the agent', async () => {
    const { env, asked } = deployment()
    const hook = `${APP}/hooks/myagent/user-1/${'x'.repeat(43)}`
    const testEnv = { ...env, CREDENTIAL_KEY: 'Z29ibGluLXRlc3QtZml4dHVyZS1rZXkhISEhISEhISE=' }
    const response = await worker.fetch(new Request(hook, { method: 'POST', body: '{}' }), testEnv, {
      waitUntil: () => undefined,
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ error: { code: 'not_found', what: 'route' } })
    expect(asked).toEqual([])
  })

  // The paid endpoint is imported on its first call, so mppx and viem stay out of every isolate's startup.
  it("loads goblin's paid model endpoint on a call to it: a Tempo charge where the stage sells it, else a 404", async () => {
    const { env, asked } = deployment()
    const selling = {
      ...env,
      MODEL_BASE_URL: 'https://no-model-calls.invalid/v1',
      MODEL_KEY: 'test',
      MODEL_ID: 'deepseek-v4.1-flash',
      PAID_INFERENCE: 'goblin',
      MPP_RECIPIENT: '0x6649868b1B87711e405aa6690E3f0245d9510631',
      MPP_SECRET: 'a-test-secret-of-at-least-thirty-two-chars',
    }
    const call = () =>
      new Request(`${APP}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-v4.1-flash', max_tokens: 1, messages: [] }),
      })
    const paid = await worker.fetch(call(), selling, { waitUntil: () => undefined })
    expect(paid.status).toBe(402)
    expect(paid.headers.get('www-authenticate')).toMatch(/method="tempo"/u)
    const unsold = await worker.fetch(call(), { ...selling, PAID_INFERENCE: 'tempo' }, { waitUntil: () => undefined })
    expect(unsold.status).toBe(404)
    expect(asked).toEqual([])
  })
})
