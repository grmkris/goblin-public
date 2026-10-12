import { formatUnits, parseUnits } from '@goblin/wallet/amounts'
import { ensureUsdc, TransferError } from '@goblin/wallet/balances'
import { BASE, TEMPO } from '@goblin/wallet/chains'
import type { Operation, ServiceRule, Terms } from '@goblin/wallet/contract'
import { isTempoAgent, payMpp, probeMpp, TempoError } from '@goblin/wallet/tempo'
import { payX402, probeX402, X402Error } from '@goblin/wallet/x402'
import type { PaidResponse, PayOutcome } from '../services/rails.ts'
import { RailError, type RailsDeps } from './deps.ts'
import { outcomeOfError } from './transfer.ts'

/** The request a service call becomes: a JSON body for POST, query parameters for GET. */
export const requestOf = (service: ServiceRule, args: Record<string, unknown>) => {
  if (service.method === 'POST')
    return {
      method: 'POST' as const,
      url: service.url,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(args),
    }
  const url = new URL(service.url)
  for (const [key, value] of Object.entries(args))
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      url.searchParams.set(key, String(value))
  return { method: 'GET' as const, url: url.toString(), headers: { accept: 'application/json' } }
}

const FIVE_MINUTES = 300_000

interface Candidate {
  readonly rail: 'x402' | 'mpp'
  readonly terms: Terms
}

const termsOf = (
  service: ServiceRule,
  rail: 'x402' | 'mpp',
  quote: { amount: string; recipient: string; usd: string; expiresAt: string },
): Terms => {
  const chain = rail === 'x402' ? BASE : TEMPO
  return {
    kind: 'paid_fetch',
    chain: rail === 'x402' ? 'base' : 'tempo',
    rail,
    subject: service.id,
    token: { symbol: chain.usdc.symbol, address: chain.usdc.address, decimals: chain.usdc.decimals },
    amount: formatUnits(BigInt(quote.amount), chain.usdc.decimals),
    amountUsd: quote.usd,
    recipient: quote.recipient,
    request: { method: service.method, url: requestOf(service, {}).url.split('?')[0] ?? service.url },
    expiresAt: quote.expiresAt,
  }
}

/** Probes each allowed rail; a rail the server does not offer is simply not a candidate. */
const probes = async (service: ServiceRule, args: Record<string, unknown>, deps: RailsDeps, want?: 'x402' | 'mpp') => {
  const request = requestOf(service, args)
  const now = (deps.now ?? (() => new Date()))()
  const fetchFn = deps.fetchFn ?? fetch
  const rails = service.rails.filter((rail) => want === undefined || rail === want)
  const found: Candidate[] = []
  if (rails.includes('x402')) {
    const probe = await probeX402(request, fetchFn)
    if (probe.kind === 'quote')
      found.push({
        rail: 'x402',
        terms: termsOf(service, 'x402', {
          amount: probe.quote.terms.amount,
          recipient: probe.quote.terms.recipient,
          usd: probe.quote.amountUsd,
          expiresAt: new Date(now.getTime() + FIVE_MINUTES).toISOString(),
        }),
      })
  }
  if (rails.includes('mpp')) {
    const probe = await probeMpp(request, fetchFn)
    if (probe.kind === 'quote')
      found.push({
        rail: 'mpp',
        terms: termsOf(service, 'mpp', {
          amount: probe.quote.terms.amount,
          recipient: probe.quote.terms.recipient,
          usd: probe.quote.amountUsd,
          expiresAt: probe.quote.expiresAt ?? new Date(now.getTime() + FIVE_MINUTES).toISOString(),
        }),
      })
  }
  return found
}

/** The cheapest offered rail; on a tie Base x402 wins, because the agent's Base balance can be topped up on demand. */
export const quotePaidFetch = async (
  service: ServiceRule,
  args: Record<string, unknown>,
  deps: RailsDeps,
  want?: 'x402' | 'mpp',
): Promise<Terms> => {
  // The paid services price and settle on Base and Tempo mainnet; a testnet wallet would pay them real money.
  if (!deps.live) throw new RailError('Paid services take mainnet payments only; this wallet is on testnets.')
  const found = await probes(service, args, deps, want)
  const cheapest = found.toSorted(
    (a, b) =>
      Number(parseUnits(a.terms.amountUsd, 6) - parseUnits(b.terms.amountUsd, 6)) || (a.rail === 'x402' ? -1 : 1),
  )[0]
  if (cheapest === undefined) throw new RailError(`${service.id} offers no price on a rail this wallet can pay.`)
  return cheapest.terms
}

const BODY_LIMIT = 32_000

/** Reads at most `BODY_LIMIT` bytes from the stream and cancels the rest, so an endless body is never buffered. */
const readBounded = async (response: Response): Promise<{ text: string; truncated: boolean }> => {
  if (response.body === null) return { text: '', truncated: false }
  // SAFETY: a fetch Response body is a byte stream.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const room = BODY_LIMIT - size
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room))
        truncated = true
        break
      }
      chunks.push(value)
      size += value.byteLength
    }
  } finally {
    // expected: cancelling an already-cut stream may fail; the bytes we kept are what matter.
    if (truncated) await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), truncated }
}

/** The paid response, bounded: JSON parsed when it fits, otherwise text cut at the byte limit while streaming. */
export const boundedResponse = async (response: Response): Promise<PaidResponse> => {
  const contentType = response.headers.get('content-type') ?? 'application/octet-stream'
  const { text, truncated } = await readBounded(response)
  if (!truncated && contentType.includes('json')) {
    try {
      const body: unknown = JSON.parse(text)
      return { status: response.status, contentType, body, truncated }
    } catch {
      // expected: a body that claims JSON but is not stays as text.
    }
  }
  return { status: response.status, contentType, body: text, truncated }
}

const atomic = (terms: Terms): string => parseUnits(terms.amount, terms.token.decimals).toString()

/** Pays a reserved `paid_fetch` operation over the rail its frozen terms name. */
export const payPaidFetch = async (
  operation: Operation,
  service: ServiceRule,
  args: Record<string, unknown>,
  deps: RailsDeps,
): Promise<PayOutcome> => {
  const { signer } = deps
  if (signer === undefined) return { outcome: 'failed', reason: 'The owner has not created the agent wallet yet.' }
  if (!deps.live)
    return { outcome: 'failed', reason: 'Paid services take mainnet payments only; this wallet is on testnets.' }
  const { terms } = operation
  const request = requestOf(service, args)
  const common = {
    request,
    maxUsd: terms.amountUsd,
    operationKey: operation.id,
    ...(deps.fetchFn === undefined ? {} : { fetchFn: deps.fetchFn }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  }
  try {
    if (terms.rail === 'x402') {
      await ensureUsdc({
        live: deps.live,
        chain: 'base',
        amount: BigInt(atomic(terms)),
        operationKey: operation.id,
        agent: signer,
        rpc: deps.rpcFor('base'),
        topUp: await deps.topUp?.('base'),
        wait: deps.wait,
      })
      const paid = await payX402({
        ...common,
        agent: signer,
        terms: { network: BASE.caip2, asset: terms.token.address, recipient: terms.recipient, amount: atomic(terms) },
      })
      return await outcomeOf(paid.outcome, paid.payment, paid.response)
    }
    if (!isTempoAgent(signer)) return { outcome: 'failed', reason: 'The agent wallet cannot sign on Tempo yet.' }
    const paid = await payMpp({
      ...common,
      agent: signer,
      terms: { network: TEMPO.caip2, asset: terms.token.address, recipient: terms.recipient, amount: atomic(terms) },
    })
    return await outcomeOf(paid.outcome, paid.payment, paid.response)
  } catch (error) {
    // expected: a rail error before the credential left means no money moved; the spend program releases the hold.
    if (error instanceof TransferError) return outcomeOfError(error)
    if (error instanceof X402Error || error instanceof TempoError || error instanceof RailError)
      return { outcome: 'failed', reason: error.message }
    return { outcome: 'failed', reason: 'The payment could not be prepared; nothing was paid.' }
  }
}

const outcomeOf = async (
  outcome: 'settled' | 'unsettled' | 'unknown',
  payment: Extract<PayOutcome, { outcome: 'settled' }>['payment'] | undefined,
  response: Response,
): Promise<PayOutcome> => {
  if (outcome === 'settled' && payment !== undefined) {
    // The settlement is proven: a body that cannot be read changes the delivery, never the payment.
    try {
      const bounded = await boundedResponse(response)
      return { outcome: 'settled', payment, delivery: { status: String(response.status) }, response: bounded }
    } catch {
      // expected: the stream broke after the service settled; the receipt is kept and delivery reported failed.
      return {
        outcome: 'settled',
        payment,
        delivery: { status: 'failed', detail: 'The payment settled but the response body could not be read.' },
      }
    }
  }
  if (outcome === 'unsettled')
    return {
      outcome: 'failed',
      reason: `The service did not accept the payment (HTTP ${response.status}); nothing was paid.`,
    }
  return {
    outcome: 'uncertain',
    reason: `The service answered HTTP ${response.status} without a payment receipt; the payment may have gone through.`,
  }
}
