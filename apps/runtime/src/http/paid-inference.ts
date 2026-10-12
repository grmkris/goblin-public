// goblin's own model endpoint for inference paid per call (ADR 0047): an OpenAI-compatible chat completion behind an
// MPP `tempo` charge in USDC.e, paid to the deployment's recipient and forwarded to goblin's LiteLLM. The price is set
// up front from the call's tokens, as Tempo's proxy sets it; the payment is the only credential.
import { Mppx, tempo } from 'mppx/server'
import { usdce } from 'viem/tokens'
import type { RuntimeEnv } from '../env.ts'
import { isRecord } from '../runtime/digest.ts'
import { modelOptions, paidRoutes } from '../models.ts'
import { MAX_OUTPUT_TOKENS } from '../pi/model.ts'

/** Tempo's floor for one call, in USDC.e base units (6 decimals): $0.00075. */
const FLOOR_UNITS = 750

/** The output limit a call asks for, as goblin caps it; a call that names none is priced at the cap. */
const outputLimit = (body: Readonly<Record<string, unknown>>): number => {
  const asked = body['max_completion_tokens'] ?? body['max_tokens']
  return typeof asked === 'number' && Number.isFinite(asked) && asked > 0
    ? Math.min(Math.ceil(asked), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS
}

/**
 * One call's price in USDC.e base units, set before it runs: 0.6 a unit per output token it may write and 0.1 per input
 * token (about four characters), never under the floor. The same rule as Tempo's proxy.
 */
export const priceUnits = (body: Readonly<Record<string, unknown>>): number => {
  const input = Math.ceil(JSON.stringify(body['messages'] ?? []).length / 4)
  return Math.max(FLOOR_UNITS, Math.ceil(0.6 * outputLimit(body) + 0.1 * input))
}

/** Base units as the dollar amount mppx takes: `750` is `0.000750`. */
export const dollarsOf = (units: number): string => (units / 1_000_000).toFixed(6)

/** The deployment's seller, made once per isolate: its recipient and its challenge-signing secret. */
let seller: { readonly key: string; readonly mppx: ReturnType<typeof makeSeller> } | undefined
const makeSeller = (recipient: `0x${string}`, secretKey: string, realm: string) =>
  Mppx.create({ methods: [tempo.charge({ currencies: [usdce], recipient })], secretKey, realm })
const sellerOf = (env: RuntimeEnv, recipient: `0x${string}`, secret: string) => {
  const key = `${recipient}:${env.APP_URL}`
  if (seller?.key !== key) seller = { key, mppx: makeSeller(recipient, secret, new URL(env.APP_URL).host) }
  return seller.mppx
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u
const isAddress = (value: string | undefined): value is `0x${string}` => value !== undefined && ADDRESS.test(value)

const refuse = (status: number, message: string) => Response.json({ error: { message } }, { status })

/**
 * `POST /v1/chat/completions` for a stage that offers `goblin` in `PAID_INFERENCE` with a recipient and a secret:
 * unpaid, a 402 MPP challenge priced from the body; paid, goblin's LiteLLM answers, with the payment's receipt. Only the
 * deployment's own models are sold; anything else is a 404 or a 400 before a challenge is made.
 */
export async function paidCompletion(request: Request, env: RuntimeEnv): Promise<Response | undefined> {
  const recipient = env.MPP_RECIPIENT
  const secret = env.MPP_SECRET ?? ''
  const offered = paidRoutes(env.PAID_INFERENCE).some((route) => route.id === 'paid:goblin')
  if (!offered || !isAddress(recipient) || secret.length < 32) return undefined
  if (request.method !== 'POST') return refuse(405, 'POST a chat completion.')
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => {
      // expected: a body that is not JSON is the caller's mistake, refused just below with a 400.
      return undefined
    })
  if (!isRecord(body)) return refuse(400, 'The body is not a JSON object.')
  const fields = body
  const model = fields['model']
  if (typeof model !== 'string' || !modelOptions(env.MODELS, env.MODEL_ID).some((option) => option.id === model))
    return refuse(400, 'This model is not sold here.')
  const paid = await sellerOf(env, recipient, secret).charge({ amount: dollarsOf(priceUnits(fields)) })(request)
  if (paid.status === 402) return paid.challenge
  const upstream = await fetch(new URL('chat/completions', `${env.MODEL_BASE_URL.replace(/\/+$/u, '')}/`), {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MODEL_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  })
  const headers = new Headers({ 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
  return paid.withReceipt(new Response(upstream.body, { status: upstream.status, headers }))
}
