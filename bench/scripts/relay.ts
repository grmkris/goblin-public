import { Config, DateTime, Effect, FileSystem, Redacted, Schema, Semaphore } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { providerDetails } from '../src/provider-details.ts'
import { Budget, usageOf, transientStatus, type Totals } from '../src/budget.ts'
import { ChatRequest, fakeResponse } from '../src/fake.ts'
import { Trace, type Resolved } from '../src/results.ts'
import { serveLocal } from './http-server.ts'
import { appendJson, readLedger, io, fail, type BenchError } from './store.ts'

export const ProviderConfig = Schema.Struct({ baseUrl: Schema.String, keyEnv: Schema.String })
export type ProviderConfig = typeof ProviderConfig.Type

export const validateProvider = Effect.fn('bench.providerConfig')(function* (path: string, provider: ProviderConfig) {
  const fs = yield* FileSystem.FileSystem
  const stat = yield* fs.stat(path)
  if ((stat.mode & 0o077) !== 0) return yield* fail('Provider configuration must be mode 600')
  const url = new URL(provider.baseUrl)
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.port !== '8317' ||
    !['/v1', '/v1/'].includes(url.pathname) ||
    provider.keyEnv !== 'CLIPROXY_API_KEY'
  )
    return yield* fail('Local benchmarks use CLIProxy at loopback port 8317 with CLIPROXY_API_KEY')
})
export const providerCatalog = Effect.fn('bench.providerCatalog')(function* (provider: ProviderConfig) {
  const client = yield* HttpClient.HttpClient
  const key = yield* Config.Redacted(provider.keyEnv)
  const response = yield* client.execute(
    HttpClientRequest.get(`${provider.baseUrl.replace(/\/+$/u, '')}/models`).pipe(HttpClientRequest.bearerToken(key)),
  )
  if (response.status !== 200) return yield* fail(`Model catalog returned ${response.status}`)
  const catalog = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
  )(yield* response.json)
  return catalog.data.map((model) => model.id)
})
type Label = { readonly scope: string; readonly phase: 'build' | 'answer' }
type Reply = {
  readonly status: number
  readonly text: string
  readonly contentType: string
  readonly requestId?: string
}
type Send = (payload: string, body: ChatRequest, scope: string) => Effect.Effect<Reply, BenchError>
type Accounting = { readonly path: string; readonly budget: Budget; readonly records: Trace[] }

const restoredTotals = (traces: readonly Trace[]): Totals =>
  [...new Map(traces.map((trace) => [trace.attempt, trace])).values()].reduce(
    (total, trace) => ({
      requests: total.requests + 1,
      input: total.input + trace.input,
      output: total.output + trace.output,
    }),
    { requests: 0, input: 0, output: 0 },
  )

function liveTransport(
  client: HttpClient.HttpClient,
  provider: ProviderConfig,
  key: Redacted.Redacted,
  runId: string,
): Send {
  return (payload, _body, scope) =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(`${provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(key)),
        HttpClientRequest.setHeader('X-Session-ID', runId),
        HttpClientRequest.setHeader('X-Bench-Operation-ID', scope),
        HttpClientRequest.bodyText(payload, 'application/json'),
      )
      const response = yield* client.execute(request)
      return {
        status: response.status,
        text: yield* response.text,
        contentType: response.headers['content-type'] ?? 'application/json',
        ...(response.headers['x-request-id'] === undefined ? {} : { requestId: response.headers['x-request-id'] }),
      }
    }).pipe(
      Effect.timeout('120 seconds'),
      Effect.mapError(() => fail('Provider transport failed')),
    )
}
const fakeTransport: Send = (_payload, body) =>
  io(async () => {
    const response = fakeResponse(body)
    return {
      status: response.status,
      text: await response.text(),
      contentType: response.headers.get('content-type') ?? '',
    }
  })

const attempt = Effect.fn('bench.attempt')(function* (
  account: Accounting,
  label: Label,
  send: Send,
  request: { payload: string; body: ChatRequest; output: number; retry: number },
) {
  const reservation = { input: new TextEncoder().encode(request.payload).length, output: request.output }
  if (!account.budget.reserve(reservation))
    return {
      status: 402,
      text: '{"error":{"message":"Benchmark allowance exhausted"}}',
      contentType: 'application/json',
    }
  const at = yield* DateTime.now
  const started: Trace = {
    ...label,
    model: request.body.model,
    attempt: account.budget.totals().requests,
    status: 0,
    ...reservation,
    unknownUsage: true,
    request: request.payload,
    response: '',
    at: DateTime.formatIso(at),
    retryIndex: request.retry,
    reservedInput: reservation.input,
    reservedOutput: reservation.output,
  }
  yield* appendJson(account.path, started)
  account.records.push(started)
  const reply = yield* send(request.payload, request.body, label.scope).pipe(
    Effect.catchTag('BenchError', () =>
      Effect.succeed<Reply>({ status: 503, text: 'Transport failed', contentType: 'application/json' }),
    ),
  )
  const elapsed = DateTime.toEpochMillis(yield* DateTime.now) - DateTime.toEpochMillis(at)
  const usage = usageOf(reply.text)
  const details = providerDetails(reply.text)
  account.budget.reconcile(reservation, usage)
  const finished: Trace = {
    ...started,
    status: reply.status,
    input: usage?.input ?? reservation.input,
    output: usage?.output ?? reservation.output,
    unknownUsage: usage === undefined,
    response: reply.text,
    latencyMs: elapsed,
    ...(reply.requestId === undefined ? {} : { requestId: reply.requestId }),
    ...(details.responseModel === undefined ? {} : { responseModel: details.responseModel }),
    ...(details.responseId === undefined ? {} : { responseId: details.responseId }),
    ...(details.reasoningTokens === undefined ? {} : { reasoningTokens: details.reasoningTokens }),
    ...(details.cacheReadTokens === undefined ? {} : { cacheReadTokens: details.cacheReadTokens }),
    ...(details.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: details.cacheWriteTokens }),
  }
  yield* appendJson(account.path, finished)
  account.records.push(finished)
  return reply
})

const handleRequest = Effect.fn('bench.relay.request')(function* (
  request: Request,
  account: Accounting,
  label: Label,
  send: Send,
  allowed: ReadonlySet<string>,
) {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions')
    return new Response('not found', { status: 404 })
  const raw = yield* io(() => request.json())
  const body = yield* Schema.decodeUnknownEffect(ChatRequest)(raw)
  if (!allowed.has(body.model) || label.scope === 'unassigned')
    return new Response('unassigned model request', { status: 403 })
  const original = yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(raw)
  const output = body.max_completion_tokens ?? body.max_tokens ?? 8192
  if (!Number.isSafeInteger(output) || output <= 0 || output > 8192)
    return new Response('invalid output reservation', { status: 400 })
  const payload = JSON.stringify({ ...original, ...(body.stream ? { stream_options: { include_usage: true } } : {}) })
  let reply: Reply = { status: 503, text: '', contentType: 'application/json' }
  for (let retry = 0; retry < 2; retry += 1) {
    reply = yield* attempt(account, label, send, { payload, body, output, retry })
    if (!transientStatus(reply.status)) break
    if (retry === 0) yield* Effect.sleep('250 millis')
  }
  return new Response(reply.text, { status: reply.status, headers: { 'content-type': reply.contentType } })
})

/** Scoped credential boundary. Every upstream attempt reserves and records before it starts. */
export const relay = Effect.fn('bench.relay')(function* (
  resolved: Resolved,
  path: string,
  provider: ProviderConfig | undefined,
) {
  const client = yield* HttpClient.HttpClient
  const fs = yield* FileSystem.FileSystem
  const previous = yield* readLedger(path, Trace)
  const account: Accounting = {
    path,
    budget: new Budget(resolved.manifest.allowance, restoredTotals(previous)),
    records: [...previous],
  }
  const send =
    provider === undefined
      ? fakeTransport
      : liveTransport(client, provider, yield* Config.Redacted(provider.keyEnv), resolved.runId)
  const gate = Semaphore.makeUnsafe(1)
  let label: Label = { scope: 'unassigned', phase: 'build' }
  const labels = new Map<string, Label>()
  const allowed = new Set(
    resolved.manifest.variants.flatMap((variant) => [variant.reader, variant.writer ?? variant.reader]),
  )
  const handle = (request: Request) =>
    handleRequest(
      request,
      account,
      labels.get(request.headers.get('x-bench-scope') ?? '') ?? { scope: 'unassigned', phase: 'build' },
      send,
      allowed,
    ).pipe(gate.withPermits(1), Effect.provideService(FileSystem.FileSystem, fs))
  const server = yield* Effect.acquireRelease(
    io(() => startServer(handle)),
    (resource) => io(resource.stop).pipe(Effect.orDie),
  )
  return {
    url: server.url,
    totals: () => account.budget.totals(),
    setScope: (scope: string, phase: Label['phase']) => {
      label = { scope, phase }
      labels.set(scope, label)
    },
    traces: (scope: string) => account.records.filter((record) => record.scope === scope && record.status !== 0),
    allTraces: () => account.records,
  }
})
function startServer(handle: (request: Request) => Effect.Effect<Response, unknown>) {
  return serveLocal(18873, (request) => Effect.runPromise(handle(request)))
}
