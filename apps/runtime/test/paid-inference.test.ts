import { describe, expect, it } from 'vitest'
import type { AssistantMessage, Model, ProviderStreams, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { PayRoute } from '@goblin/contracts'
import type { Tool } from '@modelcontextprotocol/client'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { Budget } from '../src/budget.ts'
import {
  challengeId,
  payInferenceChallenge,
  paymentFailureText,
  settleInferencePayment,
} from '../src/mcp/inference-pay.ts'
import { McpConnections, McpServers } from '../src/mcp/service.ts'
import { stub } from './http/api/fixture.ts'
import { toolOffered } from '../src/mcp/remote.ts'
import { modelOptions, paidRoutes } from '../src/models.ts'
import { budgetExtension } from '../src/pi/budget.ts'
import { CONVERSATION_CALL, headersOf, makePiModels, modelRef, payingFetch } from '../src/pi/model.ts'
import type { RunProgram } from '../src/runtime/bridge.ts'
import { fake } from './fake.ts'

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

  it('sells the routes the stage names, and keeps them out of the model picker: the pick stays a model', () => {
    expect(paidRoutes('tempo, goblin, nope').map((route) => route.name)).toEqual(['tempo', 'goblin'])
    expect(modelOptions('qwen3.8-flash', 'deepseek-v4.1-flash').map((option) => option.id)).toEqual([
      'deepseek-v4.1-flash',
      'qwen3.8-flash',
    ])
    expect(modelRef('qwen3.8-flash')).toEqual({ provider: 'goblin-litellm', id: 'qwen3.8-flash' })
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

/** A model call as the scripted provider saw it. */
type Sent = {
  readonly provider: string
  readonly model: string
  readonly baseUrl: string
  readonly apiKey: string | undefined
  readonly maxRetries: number | undefined
  readonly paying: boolean
}

/** A provider that records each call and answers it at once, as the provider it was sent to. */
const scripted = () => {
  const sent: Sent[] = []
  const answer = (model: Model<string>, _context: unknown, options?: SimpleStreamOptions) => {
    sent.push({
      provider: model.provider,
      model: model.id,
      baseUrl: model.baseUrl,
      apiKey: options?.apiKey,
      maxRetries: options?.maxRetries,
      paying: options?.fetch !== undefined,
    })
    const events = createAssistantMessageEventStream()
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    const message: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
      stopReason: 'stop',
      timestamp: 1,
    }
    events.push({ type: 'done', reason: 'stop', message })
    events.end(message)
    return events
  }
  const streams: ProviderStreams = { stream: answer, streamSimple: answer }
  return { sent, streams }
}

/** goblin's models with the owner's pay mode in front, the route answered by `route` (counted). */
const routed = (route: () => PayRoute | undefined) => {
  const { sent, streams } = scripted()
  let asked = 0
  const env = {
    MODEL_ID: 'deepseek-v4.1-flash',
    MODELS: 'qwen3.8-flash',
    MODEL_BASE_URL: 'https://litellm.invalid/v1',
    MODEL_KEY: 'goblin-litellm-key',
    PAID_INFERENCE: 'goblin,tempo',
    APP_URL: 'https://goblin.invalid',
  }
  const { models } = makePiModels(env, streams, undefined, undefined, {
    pay: never,
    route: async () => {
      asked += 1
      return route()
    },
  })
  const call = async (id: string, conversation = true) => {
    const model = models.getModel('goblin-litellm', id)
    if (model === undefined) throw new Error(`no model ${id}`)
    const context = { messages: [{ role: 'user' as const, content: 'hi', timestamp: 1 }] }
    return models.completeSimple(model, context, conversation ? { metadata: { ...CONVERSATION_CALL } } : {})
  }
  return { sent, call, asked: () => asked }
}

describe('a conversation call follows the owner pay mode (ADR 0047)', () => {
  it("goes to LiteLLM on goblin's key while Credits pay", async () => {
    const { sent, call } = routed(() => undefined)
    await call('qwen3.8-flash')
    expect(sent).toEqual([
      {
        provider: 'goblin-litellm',
        model: 'qwen3.8-flash',
        baseUrl: 'https://litellm.invalid/v1',
        apiKey: 'goblin-litellm-key',
        maxRetries: undefined,
        paying: false,
      },
    ])
  })

  it("goes to goblin's own paid endpoint with the same model id, paying its way, never with goblin's key", async () => {
    const { sent, call } = routed(() => 'goblin')
    const answer = await call('qwen3.8-flash')
    expect(sent).toEqual([
      {
        provider: 'goblin-paid-goblin',
        model: 'qwen3.8-flash',
        baseUrl: 'https://goblin.invalid/v1',
        apiKey: 'mpp',
        maxRetries: 0,
        paying: true,
      },
    ])
    // The answer names the paid provider, which is how the budget knows not to count it in Credits.
    expect(answer.provider).toBe('goblin-paid-goblin')
  })

  it("goes to Tempo's proxy on its own DeepSeek, whatever model is picked", async () => {
    const { sent, call } = routed(() => 'tempo')
    await call('qwen3.8-flash')
    expect(sent.map((each) => ({ provider: each.provider, model: each.model, baseUrl: each.baseUrl }))).toEqual([
      {
        provider: 'goblin-paid-tempo',
        model: 'deepseek/deepseek-v4.1-flash',
        baseUrl: 'https://openrouter.mpp.tempo.xyz/v1',
      },
    ])
  })

  it('asks before every call, so a turn whose Credits run out midway goes on paid', async () => {
    let spent = false
    const { sent, call, asked } = routed(() => (spent ? 'goblin' : undefined))
    await call('deepseek-v4.1-flash')
    spent = true
    await call('deepseek-v4.1-flash')
    expect(asked()).toBe(2)
    expect(sent.map((each) => each.provider)).toEqual(['goblin-litellm', 'goblin-paid-goblin'])
  })

  it("keeps goblin's housekeeping (no conversation mark) on Credits without asking the pay mode", async () => {
    const { sent, call, asked } = routed(() => 'goblin')
    await call('deepseek-v4.1-flash', false)
    expect(asked()).toBe(0)
    expect(sent.map((each) => each.provider)).toEqual(['goblin-litellm'])
  })
})

describe('a paid answer costs no Credits (ADR 0047)', () => {
  it('records a LiteLLM answer in the day, and nothing for one paid from the wallet', async () => {
    const recorded: (string | undefined)[] = []
    const layer = Layer.succeed(
      Budget,
      fake<typeof Budget.Service>({ record: (_use, _now, model) => Effect.sync(() => void recorded.push(model)) }),
    )
    // SAFETY: the budget hook's programs read only the budget.
    const run = ((program: Effect.Effect<unknown>) =>
      Effect.runPromise(program.pipe(Effect.provide(layer)))) as RunProgram
    const [generation] = budgetExtension(run).hooks ?? []
    // SAFETY: the extension's first hook is GenerationTask's; `afterResponse` reads the answer only.
    const handlers = generation?.handlers as { readonly afterResponse: (message: unknown) => Promise<void> }
    const { afterResponse } = handlers
    const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
    await afterResponse({ provider: 'goblin-litellm', model: 'qwen3.8-flash', usage })
    await afterResponse({ provider: 'goblin-paid-goblin', model: 'qwen3.8-flash', usage })
    await afterResponse({ provider: 'goblin-paid-tempo', model: 'deepseek/deepseek-v4.1-flash', usage })
    expect(recorded).toEqual(['qwen3.8-flash'])
  })
})
