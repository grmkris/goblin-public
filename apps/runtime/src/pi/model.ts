import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type { AssistantMessage, FetchFunction, Model, ProviderStreams } from '@earendil-works/pi-ai'
import type { ModelOption } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { modelOptions, paidRoute, paidRoutes } from '../models.ts'

type ModelEnvironment = Pick<RuntimeEnv, 'MODEL_ID' | 'MODEL_BASE_URL' | 'MODEL_KEY'> &
  Partial<Pick<RuntimeEnv, 'MODELS' | 'PAID_INFERENCE' | 'APP_URL'>>

/** Every model is served by the deployment's LiteLLM under one provider id; `session.setModel` names it. */
export const MODEL_PROVIDER = 'goblin-litellm'

/**
 * The most a model writes in one response. pi-ai sends it on every request (clamped to what the context leaves), and
 * reasoning models spend part of it thinking, so it is generous: at 8,192 glm-5.3 and qwen3.8-max ran out mid-answer.
 * A response cut here ends with `stopReason: 'length'`, which the owner sees.
 */
export const MAX_OUTPUT_TOKENS = 32_768

/** The provider is configured at the Worker boundary; its key never enters Pi state. */
function makePiModel(
  option: ModelOption,
  baseUrl: string,
  contextWindow?: number,
  provider = MODEL_PROVIDER,
): Model<'openai-completions'> {
  return {
    id: option.id,
    name: option.label,
    provider,
    api: 'openai-completions',
    baseUrl,
    input: option.images ? ['text', 'image'] : ['text'],
    reasoning: false,
    contextWindow: contextWindow ?? option.contextWindow,
    maxTokens: MAX_OUTPUT_TOKENS,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}

/**
 * The least room an answer is sent with. pi-ai clamps the output limit to what the context leaves, down to one token,
 * and a reasoning model spends a small limit thinking: glm-5.3 on a full Personal chat answered one token, cut off,
 * which Pi does not take for a full context. Below this the request is not sent: it fails as a context overflow, so
 * Pi compacts the conversation and tries once more.
 */
export const MIN_ANSWER_ROOM = 4096

/** A response that never reached the provider: the context leaves too little room for an answer. */
function tooFull(model: Model<'openai-completions'>, room: number) {
  const events = createAssistantMessageEventStream()
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { ...zero, totalTokens: 0, cost: { ...zero, total: 0 } },
    stopReason: 'error',
    // Worded to match pi-ai's overflow patterns ("exceeds the context window"), which start Pi's compaction.
    errorMessage: `The conversation exceeds the context window: ${String(room)} tokens left for the answer.`,
    timestamp: Date.now(),
  }
  events.push({ type: 'error', reason: 'error', error: message })
  events.end()
  return events
}

/**
 * Pays one MPP challenge from the owner's Goblin Wallet (ADR 0047): the request it was answered for and the raw
 * `WWW-Authenticate` value, and back the credential for `Authorization: Payment …`. A refusal throws, with words the
 * owner can act on.
 */
export type PayChallenge = (request: {
  readonly url: string
  readonly method: string
  readonly challenge: string
}) => Promise<string>

/**
 * A fetch that pays its way: a 402 with a payment challenge is paid through `pay` and the request sent once more with
 * the credential; anything else is answered as it came. The body is kept for the second send.
 */
export const payingFetch = (pay: PayChallenge, inner: FetchFunction = fetch): FetchFunction => {
  const paying = async (input: Parameters<FetchFunction>[0], init?: Parameters<FetchFunction>[1]) => {
    const first = await inner(input, init)
    const challenge = first.headers.get('www-authenticate')
    if (first.status !== 402 || challenge === null) return first
    const url = input instanceof Request ? input.url : String(input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    // A refused payment answers as the provider's own refusal would: the client neither retries it (paying again) nor
    // swaps its words for a connection error.
    const credential = await pay({ url, method, challenge }).catch((error: unknown) => {
      // expected: the refusal is not dropped; it becomes the provider's 402, carrying the wallet's words.
      const message = error instanceof Error ? error.message : 'Payment from your Goblin Wallet failed.'
      return Response.json({ error: { message } }, { status: 402 })
    })
    if (credential instanceof Response) return credential
    const headers = new Headers(init?.headers)
    headers.set('authorization', `Payment ${credential}`)
    // The model clients send a string body, so the same init goes out again with the credential.
    return inner(input, { ...init, headers })
  }
  // SAFETY: a fetch with the global's call signature; the model clients never use extras such as Bun's `preconnect`.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- needed where Bun's fetch type (with `preconnect`) is in scope: the web project typechecks this file too
  return paying as FetchFunction
}

/** The provider and model Pi runs for the owner's pick: a paid route's own, else goblin's LiteLLM. */
export const modelRef = (id: string): { readonly provider: string; readonly id: string } => {
  const route = paidRoute(id)
  return route === undefined ? { provider: MODEL_PROVIDER, id } : { provider: route.provider, id: route.model }
}

/** Every paid route's Pi provider starts with this (`models.ts` `PAID`). */
export const PAID_PROVIDER_PREFIX = 'goblin-paid-'

/** Where each paid route's calls go: Tempo's MPP proxy, or this deployment's own paid endpoint. */
const paidBase = (route: string, appUrl: string | undefined): string | undefined =>
  route === 'paid:tempo'
    ? 'https://openrouter.mpp.tempo.xyz/v1'
    : appUrl === undefined
      ? undefined
      : new URL('/v1', appUrl).href

/** How every model's requests reach LiteLLM: its OpenAI-compatible chat completions API, never with a starved answer. */
export const LITELLM_STREAMS: ProviderStreams = {
  stream,
  streamSimple: (model, context, options) => {
    const wanted = options?.maxTokens ?? model.maxTokens
    const room = clampMaxTokensToContext(model, context, wanted)
    // SAFETY: goblin's provider serves only openai-completions models (makePiModel).
    const target = model as Model<'openai-completions'>
    return room < Math.min(MIN_ANSWER_ROOM, wanted) ? tooFull(target, room) : streamSimple(target, context, options)
  },
}

/**
 * Every offered model (`models.ts`), the default first; `model` is the default for new sessions. `streams` carries
 * the requests; only a test passes anything but LiteLLM's.
 */
export function makePiModels(
  env: ModelEnvironment,
  streams: ProviderStreams = LITELLM_STREAMS,
  contextWindow?: number,
  authorizeRoutine?: (runId: string) => Promise<void>,
  pay?: PayChallenge,
) {
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const [first, ...rest] = options
  const model = makePiModel(first, env.MODEL_BASE_URL, contextWindow)
  const others = rest.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow))
  const provider = createProvider({
    id: MODEL_PROVIDER,
    name: 'goblin LiteLLM',
    baseUrl: env.MODEL_BASE_URL,
    models: [model, ...others],
    auth: {
      apiKey: {
        name: 'goblin model key',
        resolve: async () => ({ auth: { apiKey: env.MODEL_KEY } }),
      },
    },
    api: streams,
  })
  const models = createModels()
  models.setProvider(provider)
  if (pay !== undefined) for (const paid of paidProviders(env, streams, pay, contextWindow)) models.setProvider(paid)
  if (authorizeRoutine !== undefined) {
    const original = models.getModel.bind(models)
    models.getModel = (providerId, id) => {
      const runId = /^goblin-routine:(rr_[\w-]{1,100})$/u.exec(providerId)?.[1]
      if (runId !== undefined && models.getProvider(providerId) === undefined) {
        models.setProvider(
          createProvider({
            id: providerId,
            name: 'goblin routine',
            baseUrl: env.MODEL_BASE_URL,
            models: options.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow, providerId)),
            auth: {
              apiKey: {
                name: 'Routine model authority',
                resolve: async () => {
                  await authorizeRoutine(runId)
                  return { auth: { apiKey: env.MODEL_KEY } }
                },
              },
            },
            api: streams,
          }),
        )
      }
      return original(providerId, id)
    }
  }
  return { models, model, options }
}

/**
 * The paid routes this deployment offers (`PAID_INFERENCE`), each a provider whose calls pay their way from the owner's
 * Goblin Wallet (ADR 0047). The request carries no key of goblin's: the credential is the payment.
 */
function paidProviders(env: ModelEnvironment, streams: ProviderStreams, pay: PayChallenge, contextWindow?: number) {
  return paidRoutes(env.PAID_INFERENCE).flatMap((route) => {
    const baseUrl = paidBase(route.id, env.APP_URL)
    if (baseUrl === undefined) return []
    const option = {
      id: route.model,
      label: route.model,
      route: route.route,
      note: '',
      images: false,
      contextWindow: contextWindow ?? 131_072,
    }
    return [
      createProvider({
        id: route.provider,
        name: `goblin paid per call (${route.route})`,
        baseUrl,
        models: [makePiModel(option, baseUrl, contextWindow, route.provider)],
        auth: { apiKey: { name: 'paid per call', resolve: async () => ({ auth: { apiKey: 'mpp' } }) } },
        api: {
          stream: (model, context, options) => streams.stream(model, context, options),
          streamSimple: (model, context, options) =>
            // No client retries: each send is a new charge, and a provider's failure after payment is not paid again.
            streams.streamSimple(model, context, {
              ...options,
              maxRetries: 0,
              fetch: payingFetch(pay, options?.fetch),
            }),
        },
      }),
    ]
  })
}
