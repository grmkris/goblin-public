import { describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/client'
import { challengeId, paymentFailureText } from '../src/mcp/inference-pay.ts'
import { toolOffered } from '../src/mcp/remote.ts'
import { creditsModel, offeredModels, paidRoutes } from '../src/models.ts'
import { modelRef, payingFetch } from '../src/pi/model.ts'

const CHALLENGE = 'Payment id="ch_1", realm="openrouter.mpp.tempo.xyz", method="tempo", intent="charge", request="e30"'

/** A provider that asks for payment once, then answers the request that carries the credential. */
const provider = () => {
  const seen: { readonly authorization: string | null; readonly body: string }[] = []
  const inner: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ authorization: request.headers.get('authorization'), body: await request.text() })
    return request.headers.get('authorization')?.startsWith('Payment ') === true
      ? Response.json({ ok: true })
      : new Response(null, { status: 402, headers: { 'www-authenticate': CHALLENGE } })
  }
  return { seen, inner }
}

/** A payment tool the server keeps from (or shows to) the model, by MCP Apps visibility. */
const tool = (visibility: readonly string[]): Tool => ({
  name: 'pay_challenge',
  inputSchema: { type: 'object' },
  _meta: { ui: { visibility } },
})

describe('inference paid per call from the wallet (ADR 0047)', () => {
  it('pays a 402 once and sends the same request again with the credential', async () => {
    const { seen, inner } = provider()
    const paid: { readonly url: string; readonly challenge: string }[] = []
    const send = payingFetch(async (request) => {
      paid.push(request)
      return 'cred-1'
    }, inner)
    const response = await send('https://openrouter.mpp.tempo.xyz/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer mpp', 'content-type': 'application/json' },
      body: '{"model":"deepseek/deepseek-v4.1-flash"}',
    })
    expect(response.status).toBe(200)
    expect(paid).toEqual([
      { url: 'https://openrouter.mpp.tempo.xyz/v1/chat/completions', method: 'POST', challenge: CHALLENGE },
    ])
    expect(seen.map((each) => each.authorization)).toEqual(['Bearer mpp', 'Payment cred-1'])
    expect(seen[1]?.body).toBe(seen[0]?.body)
  })

  it('passes anything but a 402 with a challenge through, and lets a refused payment fail the call', async () => {
    const plain = payingFetch(
      async () => 'never',
      async () => new Response('fine'),
    )
    expect(await (await plain('https://example.test/')).text()).toBe('fine')
    const bare = payingFetch(
      async () => 'never',
      async () => new Response(null, { status: 402 }),
    )
    expect((await bare('https://example.test/')).status).toBe(402)
    const refused = payingFetch(async () => {
      throw new Error(paymentFailureText({ _tag: 'InvalidInput', reason: 'no_paying_wallet' }))
    }, provider().inner)
    const answer = await refused('https://example.test/')
    expect(answer.status).toBe(402)
    expect(await answer.json()).toEqual({
      error: { message: 'Payment from your Goblin Wallet failed: connect your Goblin Wallet on Connections first.' },
    })
  })

  it('offers the paid routes after the deployment models, and maps each to its provider and the model goblin pays for', () => {
    expect(paidRoutes('tempo, goblin, nope').map((route) => route.id)).toEqual(['paid:tempo', 'paid:goblin'])
    expect(offeredModels('qwen3.8-flash', 'deepseek-v4.1-flash', 'tempo').map((option) => option.id)).toEqual([
      'deepseek-v4.1-flash',
      'qwen3.8-flash',
      'paid:tempo',
    ])
    expect(modelRef('paid:tempo')).toEqual({ provider: 'goblin-paid-tempo', id: 'deepseek/deepseek-v4.1-flash' })
    expect(modelRef('qwen3.8-flash')).toEqual({ provider: 'goblin-litellm', id: 'qwen3.8-flash' })
    expect([creditsModel('paid:tempo'), creditsModel('glm-5.3')]).toEqual(['deepseek-v4.1-flash', 'glm-5.3'])
  })

  it('reads the challenge id the wallet keys a payment by', () => {
    expect(challengeId(CHALLENGE)).toBe('ch_1')
    expect(challengeId('Payment realm="x"')).toBeUndefined()
  })

  it('lets paid inference reach a payment tool kept from the model, as an App would, and nothing the model alone sees', () => {
    expect(toolOffered(tool(['app']), 'inference')).toBe(true)
    expect(toolOffered(tool(['app']), 'model')).toBe(false)
    expect(toolOffered(tool(['model']), 'inference')).toBe(false)
  })
})
