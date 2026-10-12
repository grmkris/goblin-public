import { describe, expect, it } from 'vitest'
import type { Tool } from '@modelcontextprotocol/client'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import {
  challengeId,
  payInferenceChallenge,
  paymentFailureText,
  settleInferencePayment,
} from '../src/mcp/inference-pay.ts'
import { McpConnections, McpServers } from '../src/mcp/service.ts'
import { stub } from './http/api/fixture.ts'
import { toolOffered } from '../src/mcp/remote.ts'
import { creditsModel, offeredModels, paidRoutes } from '../src/models.ts'
import { headersOf, modelRef, payingFetch } from '../src/pi/model.ts'

const CHALLENGE = 'Payment id="ch_1", realm="openrouter.mpp.tempo.xyz", method="tempo", intent="charge", request="e30"'

/** A provider that asks for payment once, then answers the request that carries the credential. */
const provider = () => {
  const seen: { readonly authorization: string | null; readonly body: string }[] = []
  const inner: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    seen.push({ authorization: request.headers.get('authorization'), body: await request.text() })
    return request.headers.get('authorization')?.startsWith('Payment ') === true
      ? Response.json({ ok: true }, { headers: { 'payment-receipt': 'rcpt-1' } })
      : new Response(null, { status: 402, headers: { 'www-authenticate': CHALLENGE } })
  }
  return { seen, inner }
}

/** A payment the test never expects to be asked for. */
const never = async () => ({ credential: 'never', settle: async () => undefined })

/** A provider that answers a paid call without a `Payment-Receipt`. */
const withoutReceipt = async (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  new Request(input, init).headers.has('authorization')
    ? Response.json({ ok: true })
    : new Response(null, { status: 402, headers: { 'www-authenticate': CHALLENGE } })

/** The owner's Goblin Wallet, connected, whose payment tool answers `answer` and records every call. */
const wallet = (answer: Record<string, unknown>) => {
  const calls: { readonly tool: string; readonly args: Record<string, unknown>; readonly caller: unknown }[] = []
  const layer = Layer.mergeAll(
    stub(McpServers, {
      list: () =>
        Effect.succeed([
          {
            connectionId: 'w1',
            label: 'Goblin Wallet',
            endpoint: 'https://wallet-dev.goblin.surf/mcp',
            status: 'connected' as const,
            live: true,
            source: 'added' as const,
          },
        ]),
    }),
    stub(McpConnections, {
      callTool: (_connectionId, tool, args, options) => {
        calls.push({ tool, args, caller: options?.caller })
        return Effect.succeed({ content: [], structuredContent: answer })
      },
    }),
  )
  return { calls, layer }
}

/** A payment tool the server keeps from (or shows to) the model, by MCP Apps visibility. */
const tool = (visibility: readonly string[]): Tool => ({
  name: 'pay_challenge',
  inputSchema: { type: 'object' },
  _meta: { ui: { visibility } },
})

/** A request's headers as `headersOf` keeps them, in order. */
const names = (value: unknown) => [...headersOf(value).entries()]

describe('inference paid per call from the wallet (ADR 0047)', () => {
  it("pays a 402 once, sends the same request again with the credential, and reports the answer's receipt", async () => {
    const { seen, inner } = provider()
    const paid: { readonly url: string; readonly challenge: string }[] = []
    const settled: string[] = []
    const send = payingFetch(async (request) => {
      paid.push(request)
      return { credential: 'cred-1', settle: async (receipt) => void settled.push(receipt) }
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
    expect(settled).toEqual(['rcpt-1'])
  })

  it('answers a paid call whose receipt does not settle, and settles nothing without one', async () => {
    const unsettled = payingFetch(
      async () => ({ credential: 'cred-2', settle: async () => Promise.reject(new Error('wallet away')) }),
      provider().inner,
    )
    expect((await unsettled('https://example.test/')).status).toBe(200)
    let reported = 0
    const noReceipt = payingFetch(
      async () => ({ credential: 'cred-3', settle: async () => void (reported += 1) }),
      withoutReceipt,
    )
    expect((await noReceipt('https://example.test/')).status).toBe(200)
    expect(reported).toBe(0)
  })

  it('passes anything but a 402 with a challenge through, and lets a refused payment fail the call', async () => {
    const plain = payingFetch(never, async () => new Response('fine'))
    expect(await (await plain('https://example.test/')).text()).toBe('fine')
    const bare = payingFetch(never, async () => new Response(null, { status: 402 }))
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

  it("keeps a request's headers in every shape a client passes them, for the paid retry", () => {
    expect(names({ 'content-type': 'application/json', x: 1 })).toEqual([['content-type', 'application/json']])
    expect(names([['content-type', 'application/json'], ['bad']])).toEqual([['content-type', 'application/json']])
    expect(names(new Headers({ accept: 'text/event-stream' }))).toEqual([['accept', 'text/event-stream']])
    expect(names(undefined)).toEqual([])
  })

  it('pays through the wallet as the inference caller, then settles the same operation with the receipt', async () => {
    const { calls, layer } = wallet({ credential: 'Payment cred-9', operation: { status: 'uncertain' } })
    const request = {
      url: 'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
      method: 'POST',
      challenge: CHALLENGE,
    }
    const paid = await Effect.runPromise(payInferenceChallenge(request).pipe(Effect.provide(layer)))
    expect(paid.credential).toBe('cred-9')
    await Effect.runPromise(settleInferencePayment(paid.payment, 'rcpt-9').pipe(Effect.provide(layer)))
    expect(calls).toEqual([
      {
        tool: 'pay_challenge',
        args: { ...request, max_usd: '0.05', operation_id: 'inference:ch_1' },
        caller: 'inference',
      },
      { tool: 'pay_challenge', args: { operation_id: 'inference:ch_1', receipt: 'rcpt-9' }, caller: 'inference' },
    ])
  })

  it('refuses a spend the wallet holds for approval, in its own words', async () => {
    const { layer } = wallet({ operation: { status: 'awaiting_approval' } })
    const request = {
      url: 'https://openrouter.mpp.tempo.xyz/v1/chat/completions',
      method: 'POST',
      challenge: CHALLENGE,
    }
    const refused = await Effect.runPromise(Effect.flip(payInferenceChallenge(request)).pipe(Effect.provide(layer)))
    expect(paymentFailureText(refused)).toBe(
      'Payment from your Goblin Wallet failed: the call is over a limit you set in the wallet.',
    )
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
