import { type Models, createModels, createProvider } from '@earendil-works/pi-ai/models'
import { lazyStream } from '@earendil-works/pi-ai/api/lazy'
import { stream, streamSimple } from '@earendil-works/pi-ai/api/openai-completions'
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream'
import type {
  AssistantMessage,
  FetchFunction,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { ModelOption, PayRoute } from '@goblin/contracts'
import type { RuntimeEnv } from '../env.ts'
import { type ModelOptions, type PaidRoute, modelOptions, paidRoutes } from '../models.ts'

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
 * A paid challenge: the credential for `Authorization: Payment …`, and how to report the service's `Payment-Receipt`
 * so the wallet settles the payment, which it holds as unknown until then. Reporting never rejects.
 */
export type PaidChallenge = {
  readonly credential: string
  readonly settle: (receipt: string) => Promise<void>
}

/**
 * Pays one MPP challenge from the owner's Goblin Wallet (ADR 0047): the request it was answered for and the raw
 * `WWW-Authenticate` value. A refusal throws, with words the owner can act on.
 */
export type PayChallenge = (request: {
  readonly url: string
  readonly method: string
  readonly challenge: string
}) => Promise<PaidChallenge>

/**
 * A request's headers, copied one by one: the runtimes' header types differ (Bun's `HeadersInit` is not the DOM's), so
 * they are read as plain values rather than handed between constructors.
 */
export const headersOf = (value: unknown): Headers => {
  const headers = new Headers()
  const put = (name: unknown, entry: unknown) => {
    if (typeof name === 'string' && typeof entry === 'string') headers.set(name, entry)
  }
  if (value instanceof Headers) {
    value.forEach((entry, name) => put(name, entry))
  } else if (Array.isArray(value)) {
    for (const pair of value) if (Array.isArray(pair)) put(pair[0], pair[1])
  } else if (value !== null && typeof value === 'object') {
    for (const [name, entry] of Object.entries(value)) put(name, entry)
  }
  return headers
}

/** How a refused payment's model error starts. The web and the run ledger read the refusal code in its brackets. */
export const PAYMENT_FAILED = 'Payment from your Goblin Wallet failed'

/**
 * The model error a refused payment ends the call with, for the owner: `Payment from your Goblin Wallet failed
 * (<code>): <why>.`. The code is a bounded token the run ledger may keep; the words never leave the owner's chat.
 */
export const paymentFailed = (code: string | undefined, why: string): string =>
  `${PAYMENT_FAILED}${code === undefined ? '' : ` (${code})`}: ${why.replace(/\.$/u, '')}.`

/** A refusal as the provider's own 402 would come: the client neither retries it nor reports a connection error. */
const refused = (message: string) => Response.json({ error: { message } }, { status: 402 })

/**
 * A fetch that pays its way: a 402 with a payment challenge is paid through `pay` and the request sent once more with
 * the credential; anything else is answered as it came. The body is kept for the second send. The paid answer's
 * receipt is reported while it streams. A service that answers the paid request with another 402 refused the payment
 * made: the call ends there, in words, and is never paid again.
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
    const paid = await pay({ url, method, challenge }).catch((error: unknown) => {
      // expected: the refusal is not dropped; it becomes the provider's 402, carrying the wallet's words.
      return refused(error instanceof Error ? error.message : paymentFailed(undefined, 'the wallet did not pay'))
    })
    if (paid instanceof Response) return paid
    const headers = headersOf(init?.headers)
    headers.set('authorization', `Payment ${paid.credential}`)
    // The model clients send a string body, so the same init goes out again with the credential.
    const answered = await inner(input, { ...init, headers })
    if (answered.status === 402) {
      await answered.body?.cancel()
      return refused(
        paymentFailed(
          'refused_after_payment',
          'the model service refused the payment your wallet made, so the call was not answered. It is not paid again',
        ),
      )
    }
    const receipt = answered.headers.get('payment-receipt')
    // Not awaited: the answer streams while the wallet checks the receipt on chain.
    if (receipt !== null)
      paid.settle(receipt).catch(() => {
        // expected: `settle` reports its own failures; an unsettled payment stays unknown in the wallet, never paid twice.
      })
    return answered
  }
  // SAFETY: a fetch with the global's call signature; the model clients never use extras such as Bun's `preconnect`.
  // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- needed where Bun's fetch type (with `preconnect`) is in scope: the web project typechecks this file too
  return paying as FetchFunction
}

/** The provider and model Pi runs for a model id: goblin's LiteLLM. Whether a call is paid is the pay mode's. */
export const modelRef = (id: string): { readonly provider: string; readonly id: string } => ({
  provider: MODEL_PROVIDER,
  id,
})

/** Every paid route's Pi provider starts with this (`models.ts` `PAID`). */
export const PAID_PROVIDER_PREFIX = 'goblin-paid-'

/** Where each paid route's calls go: Tempo's MPP proxy, or this deployment's own paid endpoint. */
const paidBase = (route: PayRoute, appUrl: string | undefined): string | undefined =>
  route === 'tempo'
    ? 'https://openrouter.mpp.tempo.xyz/v1'
    : appUrl === undefined
      ? undefined
      : new URL('/v1', appUrl).href

/**
 * Which paid route a conversation's model call goes out on now, or none for goblin's Credits (`pay-mode.ts`
 * `payingRoute`). It is asked before every call.
 */
export type PayingRoute = () => Promise<PayRoute | undefined>

/** How the owner's Goblin Wallet pays for model calls (ADR 0047): each challenge, and which route a call takes. */
export type WalletPay = { readonly pay: PayChallenge; readonly route: PayingRoute }

/**
 * The stream metadata Pi's conversations send with every model call (the harness's settings, `pi/harness.ts`). A call
 * that carries it is the owner's and follows their pay mode; one without it is goblin's housekeeping (thread titles,
 * memory, the skill learner) and always runs on Credits. openai-completions sends no metadata to the provider.
 */
export const CONVERSATION_CALL = { goblin: 'conversation' }

const conversationCall = (options: SimpleStreamOptions | undefined): boolean =>
  options?.metadata?.['goblin'] === CONVERSATION_CALL.goblin

/**
 * goblin's provider with the owner's pay mode in front: a conversation's call goes out on the paid route `route` names
 * at the moment it is made, so a turn whose Credits run out midway goes on paid, through that route's own provider in
 * `models`, which pays its way with the same model id (Tempo's route answers with its own model). Anything else, and a
 * call the route decision cannot answer, goes to LiteLLM on Credits.
 */
function payModeStreams(streams: ProviderStreams, models: Models, routes: readonly PaidRoute[], route: PayingRoute) {
  const paidModel = (name: PayRoute | undefined, model: Model<'openai-completions'>) => {
    const paid = routes.find((each) => each.name === name)
    return paid === undefined ? undefined : models.getModel(paid.provider, paid.model ?? model.id)
  }
  const routed: ProviderStreams = {
    ...streams,
    streamSimple: (model, context, options) => {
      if (!conversationCall(options)) return streams.streamSimple(model, context, options)
      return lazyStream(model, async () => {
        // expected: a route that cannot be decided keeps the call on Credits; `payingRoute` reports its own failures.
        const name = await route().catch(() => undefined)
        // SAFETY: goblin's provider serves only openai-completions models (makePiModel).
        const target = paidModel(name, model as Model<'openai-completions'>)
        if (target === undefined) return streams.streamSimple(model, context, options)
        // goblin's LiteLLM key never goes to a paid route: the paid provider's own auth answers instead.
        const { apiKey: _litellmKey, ...paidOptions } = options ?? {}
        return models.streamSimple(target, context, paidOptions)
      })
    },
  }
  return routed
}

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
 * the requests; only a test passes anything but LiteLLM's. With `wallet`, the stage's paid routes are offered too and
 * each conversation call follows the owner's pay mode (ADR 0047).
 */
export function makePiModels(
  env: ModelEnvironment,
  streams: ProviderStreams = LITELLM_STREAMS,
  contextWindow?: number,
  authorizeRoutine?: (runId: string) => Promise<void>,
  wallet?: WalletPay,
) {
  const options = modelOptions(env.MODELS, env.MODEL_ID)
  const [first, ...rest] = options
  const model = makePiModel(first, env.MODEL_BASE_URL, contextWindow)
  const others = rest.map((option) => makePiModel(option, env.MODEL_BASE_URL, contextWindow))
  const models = createModels()
  const routes = paidRoutes(env.PAID_INFERENCE)
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
    // A stage that sells no paid route pays every call with Credits, without asking.
    api: wallet === undefined || routes.length === 0 ? streams : payModeStreams(streams, models, routes, wallet.route),
  })
  models.setProvider(provider)
  if (wallet !== undefined)
    for (const paid of paidProviders(env, { routes, options, contextWindow }, streams, wallet.pay))
      models.setProvider(paid)
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
 * The paid routes this deployment sells (`PAID_INFERENCE`), each a provider whose calls pay their way from the owner's
 * Goblin Wallet (ADR 0047): goblin's own route serves every offered model under its own id, Tempo's its one model. The
 * request carries no key of goblin's: the credential is the payment.
 */
function paidProviders(
  env: ModelEnvironment,
  served: {
    readonly routes: readonly PaidRoute[]
    readonly options: ModelOptions
    readonly contextWindow: number | undefined
  },
  streams: ProviderStreams,
  pay: PayChallenge,
) {
  const { routes, options, contextWindow } = served
  return routes.flatMap((route) => {
    const baseUrl = paidBase(route.name, env.APP_URL)
    if (baseUrl === undefined) return []
    const sold =
      route.model === undefined
        ? options
        : [{ id: route.model, label: route.model, route: route.label, note: '', images: false, contextWindow: 131_072 }]
    return [
      createProvider({
        id: route.provider,
        name: `goblin paid per call (${route.label})`,
        baseUrl,
        models: sold.map((option) => makePiModel(option, baseUrl, contextWindow, route.provider)),
        auth: { apiKey: { name: 'paid per call', resolve: async () => ({ auth: { apiKey: 'mpp' } }) } },
        api: {
          stream: (model, context, streamOptions) => streams.stream(model, context, streamOptions),
          streamSimple: (model, context, streamOptions) =>
            // No client retries: each send is a new charge, and a provider's failure after payment is not paid again.
            streams.streamSimple(model, context, {
              ...streamOptions,
              maxRetries: 0,
              fetch: payingFetch(pay, streamOptions?.fetch),
            }),
        },
      }),
    ]
  })
}
